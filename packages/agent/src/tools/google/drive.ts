import { z } from 'zod';
import { extractPdfText } from '../pdf.js';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';
import { googleFetch, googleFetchRaw, isUnavailable } from './client.js';
import { DRIVE_FILE_SCOPE, DRIVE_READONLY_SCOPE } from './scopes.js';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/**
 * Reading the contents of a student's files.
 *
 * Works under either of two grants, and the difference is visible to the
 * student rather than hidden:
 *
 *   drive.file (default) -- per file. The scope grants nothing by itself; the
 *   student hands over files through the Picker. A file that exists but was
 *   not handed over is indistinguishable from one that does not exist, since
 *   Drive answers 404 to both, so "not found" is treated as "not added yet".
 *
 *   drive.readonly (opt-in) -- the whole Drive, Classroom materials included.
 *   No picking. Here a 404 really does mean the file is not there, and saying
 *   "add it in Settings" would send the student in a circle.
 *
 * Everything below the fetch is identical either way; only availability and
 * the wording of failures change. See scopes.ts for what each grant costs.
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

/*
 * Names BOTH ways out, because only one of them is what most students
 * actually want. Being told to go and attach a file, every time, is the
 * friction that makes this feature not worth using -- so the message that
 * delivers that news is also the right place to mention that they can stop
 * doing it entirely.
 */
const NO_ACCESS =
  'You have not given me access to that file yet. In Settings > Files you can either ' +
  'use "Add files" to pick it, or choose "Give access to all my Drive" so you never ' +
  'have to add files one at a time.';

const FILE_GONE =
  'That file does not exist, or it is not shared with you. Check the link, or ' +
  'ask whoever posted it to share it.';

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
      /*
       * A 404 means different things depending on the grant. Under per-file
       * access it almost always means "not handed over yet", and the fix is
       * to pick it. Under full Drive access the file really is not there, and
       * sending the student to the picker would be a wild goose chase.
       */
      if (meta.reason.includes('does not exist')) {
        return unavailable(ctx.google?.hasScope(DRIVE_READONLY_SCOPE) ? FILE_GONE : NO_ACCESS);
      }
      return meta;
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

    const extracted = await extractPdfText(new Uint8Array(bytes));
    if (!extracted.ok) {
      return extracted.reason === 'unreadable'
        ? unavailable(`"${name}" is a PDF I could not read -- it may be password protected.`)
        : unavailable(
            `"${name}" looks like a scan or photos with no text layer, so there is nothing ` +
              'for me to read. I can only read PDFs that contain real text.',
          );
    }
    return extracted.text;
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

export interface ListOptions {
  /** True when drive.readonly is granted: the whole Drive is visible. */
  broadAccess?: boolean;
  /** Match on file name. Essential once the whole Drive is in scope. */
  search?: string;
  signal?: AbortSignal;
}

/** Drive query strings are single-quoted; an apostrophe in a title breaks them. */
function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function listAccessibleFiles(
  token: string,
  options: ListOptions = {},
): Promise<AccessibleFile[] | ReturnType<typeof unavailable>> {
  const { broadAccess = false, search, signal } = options;

  const clauses = ['trashed = false'];
  if (search?.trim()) clauses.push(`name contains '${escapeQuery(search.trim())}'`);

  const result = await googleFetch<{ files?: FileMeta[] }>(
    `${FILES_URL}?q=${encodeURIComponent(clauses.join(' and '))}` +
      '&pageSize=100&orderBy=modifiedTime desc' +
      '&fields=files(id,name,mimeType,modifiedTime)' +
      '&supportsAllDrives=true&includeItemsFromAllDrives=true',
    token,
    { ...(signal ? { signal } : {}) },
  );
  if (isUnavailable(result)) return result;

  const top = result.files ?? [];

  /*
   * Folder expansion exists to work around per-file access. With
   * drive.readonly every file is already listed, so walking folders would be
   * up to 25 extra round trips returning things we already have.
   */
  const files = broadAccess ? top : await expandFolders(top, token, signal);

  return files.map((f) => ({
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

const listFilesInput = z.object({
  search: z
    .string()
    .optional()
    .describe('Match part of a file name, e.g. "exam review". Omit to list recent files.'),
});

export const listDriveFiles: Tool<z.infer<typeof listFilesInput>, unknown> = {
  id: 'google_drive_list_files',
  requiredScopes: [DRIVE_FILE_SCOPE],
  description:
    "Find files in the student's Drive and get their ids, so you can read them. Call this " +
    'when they name a document you do not have an id for, or ask what you can read. ' +
    'Pass `search` to look for a specific one by name.',
  inputSchema: listFilesInput,

  async execute({ search }, ctx) {
    const token = await ctx.google?.getAccessToken('drive');
    if (!token) {
      return unavailable(
        'Drive is not connected. Connect it in Settings to let me read your files.',
      );
    }

    const broadAccess = ctx.google?.hasScope(DRIVE_READONLY_SCOPE) ?? false;
    const files = await listAccessibleFiles(token, {
      broadAccess,
      ...(search ? { search } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (isUnavailable(files)) return files;

    if (files.length === 0) {
      /*
       * Empty means two different things, and the wrong one wastes the
       * student's time. With per-file access it means "nothing handed over
       * yet"; with full access it means the file genuinely is not there.
       */
      return {
        files: [],
        count: 0,
        note: broadAccess
          ? search
            ? `No file matching "${search}" was found in the student's Drive.`
            : 'No files found.'
          : 'The student has not added any files yet. Tell them they can either add files in ' +
            'Settings > Files, or choose "Give access to all my Drive" there so they never ' +
            'need to add files individually.',
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
