import { z } from 'zod';
import { extractText } from 'unpdf';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';
import { googleFetch, googleFetchRaw, isUnavailable } from './client.js';
import { DRIVE_FILE_SCOPE } from './scopes.js';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/**
 * Reading the contents of a student's files.
 *
 * Access is PER FILE. Holding drive.file grants nothing by itself -- the
 * student hands over individual files through the Google Picker, and only
 * those become readable. A file that exists and is not shared with the app is
 * indistinguishable from one that does not exist: Drive answers 404 to both.
 * That shapes the error handling below, because "not found" is the normal
 * response for a file the student simply has not added yet, and telling them
 * it does not exist would be both wrong and a dead end.
 *
 * See scopes.ts for why per-file rather than drive.readonly.
 */

/** Google's own formats hold no bytes to download; they must be exported. */
const EXPORT_AS: Record<string, { mime: string; label: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/plain', label: 'Google Doc' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', label: 'Google Slides' },
  // CSV keeps the row/column structure the model needs to reason about a sheet.
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', label: 'Google Sheet' },
};

/** Formats whose raw bytes are already text. */
const PLAIN_TEXT = /^(text\/|application\/(json|xml|x-yaml|javascript|rtf$))/;

/**
 * Cap on returned text.
 *
 * A course reader can run to hundreds of pages. Past a point more text stops
 * helping the answer and starts costing every subsequent turn in the
 * conversation, since it stays in the history.
 */
const MAX_CHARS = 40_000;

/** Never download the bytes of something huge to discover it is a video. */
const MAX_BYTES = 30 * 1024 * 1024;

interface FileMeta {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

const NO_ACCESS =
  'You have not given Contexto access to that file yet. Open Settings, then ' +
  'Files, and use "Add files" to pick it -- Contexto can only read files you ' +
  'hand over individually.';

const readFileInput = z.object({
  fileId: z
    .string()
    .min(1)
    .describe('Google Drive file id. Classroom materials include this as fileId.'),
});

export const readDriveFile: Tool<z.infer<typeof readFileInput>, unknown> = {
  id: 'google_drive_read_file',
  requiredScopes: [DRIVE_FILE_SCOPE],
  description:
    'Read the actual text contents of a Google Doc, Slides deck, Sheet, PDF, or text file ' +
    "from the student's Drive. Use the fileId from a Classroom material, or from " +
    'google_drive_list_files. Call this when they ask you to summarise, explain, quiz them on, ' +
    'or answer questions about a specific document -- do not guess at contents from a title.',
  inputSchema: readFileInput,

  async execute({ fileId }, ctx) {
    const token = await ctx.google?.getAccessToken('drive');
    if (!token) {
      return unavailable(
        'Drive is not connected. Connect it in Settings to let me read your files.',
      );
    }

    const meta = await googleFetch<FileMeta>(
      `${FILES_URL}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime,webViewLink&supportsAllDrives=true`,
      token,
      { ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (isUnavailable(meta)) {
      // 404 here almost always means "not handed over", not "gone".
      return meta.reason.includes('does not exist') ? unavailable(NO_ACCESS) : meta;
    }

    const mimeType = meta.mimeType ?? '';
    const name = meta.name ?? 'Untitled';

    const size = Number(meta.size ?? 0);
    if (size > MAX_BYTES) {
      return unavailable(`"${name}" is too large to read (${Math.round(size / 1024 / 1024)} MB).`);
    }

    const extracted = await extract(meta, mimeType, token, ctx.signal);
    if (isUnavailable(extracted)) return extracted;

    const truncated = extracted.length > MAX_CHARS;
    return {
      name,
      mimeType,
      ...(meta.modifiedTime ? { modifiedAt: meta.modifiedTime } : {}),
      ...(meta.webViewLink ? { link: meta.webViewLink } : {}),
      truncated,
      content: truncated ? `${extracted.slice(0, MAX_CHARS)}\n\n[truncated]` : extracted,
      ...(truncated
        ? { note: 'Only the first part of this file is shown. Say so if it matters.' }
        : {}),
    };
  },
};

async function extract(
  meta: FileMeta,
  mimeType: string,
  token: string,
  signal: AbortSignal | undefined,
): Promise<string | ReturnType<typeof unavailable>> {
  const name = meta.name ?? 'Untitled';

  const exportable = EXPORT_AS[mimeType];
  if (exportable) {
    const bytes = await googleFetchRaw(
      `${FILES_URL}/${meta.id}/export?mimeType=${encodeURIComponent(exportable.mime)}`,
      token,
      signal,
    );
    if (isUnavailable(bytes)) return bytes;
    return decode(bytes);
  }

  if (mimeType === 'application/pdf') {
    const bytes = await googleFetchRaw(`${FILES_URL}/${meta.id}?alt=media`, token, signal);
    if (isUnavailable(bytes)) return bytes;

    let text: string;
    try {
      const result = await extractText(new Uint8Array(bytes), { mergePages: true });
      text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text;
    } catch {
      // Encrypted or malformed PDFs throw rather than returning nothing.
      return unavailable(`"${name}" is a PDF I could not read -- it may be password protected.`);
    }

    /*
     * A scanned worksheet is a PDF full of images with no text layer. It
     * extracts to whitespace, and reporting that as an empty document reads
     * as a bug. Naming the cause tells the student the file needs OCR, which
     * we do not do.
     */
    if (text.trim().length < 20) {
      return unavailable(
        `"${name}" looks like a scan or photos with no text layer, so there is nothing ` +
          'for me to read. I can only read PDFs that contain real text.',
      );
    }
    return text;
  }

  if (PLAIN_TEXT.test(mimeType)) {
    const bytes = await googleFetchRaw(`${FILES_URL}/${meta.id}?alt=media`, token, signal);
    if (isUnavailable(bytes)) return bytes;
    return decode(bytes);
  }

  if (mimeType === FOLDER_MIME) {
    return unavailable(
      `"${name}" is a folder, not a document. Use google_drive_list_files to see what is ` +
        'inside it, then read those files.',
    );
  }

  if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) {
    return unavailable(`"${name}" is a ${mimeType.split('/')[0]}, so there is no text to read.`);
  }

  /*
   * Word and PowerPoint files land here. Drive will not export a file it does
   * not own the format of, so reading them means parsing the format
   * ourselves -- worth doing, not done yet. Say which file and why.
   */
  return unavailable(
    `I cannot read "${name}" yet (${mimeType || 'unknown format'}). I can read Google Docs, ` +
      'Slides, Sheets, PDFs, and plain text.',
  );
}

/** Google exports UTF-8; a lone bad byte should not fail the whole read. */
function decode(bytes: ArrayBuffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export interface AccessibleFile {
  fileId: string;
  name: string;
  kind: string;
  modifiedAt?: string;
}

/**
 * Files the student has handed over.
 *
 * Exported as a plain function because Settings lists these too, and an HTTP
 * route has no agent to build a ToolContext around. The tool below is a thin
 * wrapper; both paths therefore return the same thing.
 *
 * Under drive.file this returns exactly the picked files -- Drive scopes the
 * listing to what the app was granted, so we keep no record of our own to
 * drift out of sync when a student revokes access from their Google account.
 */
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** How deep to walk into picked folders, and how many to expand at all. */
const MAX_FOLDER_DEPTH = 3;
const MAX_FOLDERS = 25;

export async function listAccessibleFiles(
  token: string,
  signal?: AbortSignal,
): Promise<AccessibleFile[] | ReturnType<typeof unavailable>> {
  const result = await googleFetch<{ files?: FileMeta[] }>(
    `${FILES_URL}?pageSize=100&orderBy=modifiedTime desc` +
      '&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true',
    token,
    { ...(signal ? { signal } : {}) },
  );
  if (isUnavailable(result)) return result;

  const top = result.files ?? [];
  const expanded = await expandFolders(top, token, signal);

  return expanded.map((f) => ({
    fileId: f.id,
    name: f.name ?? 'Untitled',
    kind: describeKind(f.mimeType ?? ''),
    ...(f.modifiedTime ? { modifiedAt: f.modifiedTime } : {}),
  }));
}

/**
 * Walk into picked folders.
 *
 * A student picking a folder means "read what is in here" -- one action for a
 * whole course instead of one per handout, which is the difference between
 * this feature being usable and being a chore.
 *
 * Whether it works is Google's call, not ours: drive.file is documented as
 * per-file, and the docs do not say whether granting a folder cascades to its
 * contents. So this ASKS and accepts the answer. If Drive declines, the query
 * returns nothing, the folder is simply listed on its own, and per-file
 * picking still works -- no error either way, because a student picking a
 * folder that turns out not to cascade has done nothing wrong.
 *
 * Bounded on both depth and folder count. A shared drive can be enormous, and
 * an unbounded walk would hang Settings on someone else's filing habits.
 */
async function expandFolders(
  files: FileMeta[],
  token: string,
  signal: AbortSignal | undefined,
): Promise<FileMeta[]> {
  const seen = new Set(files.map((f) => f.id));
  const out = [...files];

  let frontier = files.filter((f) => f.mimeType === FOLDER_MIME);
  let budget = MAX_FOLDERS;

  for (let depth = 0; depth < MAX_FOLDER_DEPTH && frontier.length > 0 && budget > 0; depth += 1) {
    const next: FileMeta[] = [];

    for (const folder of frontier) {
      if (budget-- <= 0) break;

      const query = encodeURIComponent(`'${folder.id}' in parents and trashed = false`);
      const children = await googleFetch<{ files?: FileMeta[] }>(
        `${FILES_URL}?q=${query}&pageSize=100` +
          '&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true' +
          '&includeItemsFromAllDrives=true',
        token,
        { ...(signal ? { signal } : {}) },
      );
      // Not an error: this is the expected answer when access does not cascade.
      if (isUnavailable(children)) continue;

      for (const child of children.files ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        if (child.mimeType === FOLDER_MIME) next.push(child);
      }
    }

    frontier = next;
  }

  return out;
}

export const listDriveFiles: Tool<Record<string, never>, unknown> = {
  id: 'google_drive_list_files',
  requiredScopes: [DRIVE_FILE_SCOPE],
  description:
    'List the files the student has given Contexto access to, with their ids. Call this when ' +
    'they refer to a document by name and you do not already have its id, or when they ask ' +
    'what files you can read.',
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    const token = await ctx.google?.getAccessToken('drive');
    if (!token) {
      return unavailable(
        'Drive is not connected. Connect it in Settings to let me read your files.',
      );
    }

    const files = await listAccessibleFiles(token, ctx.signal);
    if (isUnavailable(files)) return files;

    if (files.length === 0) {
      return {
        files: [],
        count: 0,
        note:
          'The student has not added any files yet. They can add them in Settings, ' +
          'under Files.',
      };
    }
    return { files, count: files.length };
  },
};

function describeKind(mimeType: string): string {
  if (EXPORT_AS[mimeType]) return EXPORT_AS[mimeType].label;
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'application/vnd.google-apps.folder') return 'Folder';
  if (PLAIN_TEXT.test(mimeType)) return 'Text file';
  return mimeType || 'File';
}
