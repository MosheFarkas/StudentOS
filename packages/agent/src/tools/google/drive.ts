import { z } from 'zod';
import { ArchiveError, readDocx, readPptx, readZip } from '../archive.js';
import { describeOcrFailure, ocrImage, ocrPdf } from '../ocr.js';
import {
  describeTranscriptionFailure,
  transcribeMedia,
  type AudioTranscriber,
} from '../transcribe.js';
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

/**
 * The most we will pull into memory for a file we download whole.
 *
 * Raised from thirty megabytes, which was low enough to refuse ordinary course
 * readers -- and the biggest files are often the ones worth reading. It still
 * exists because a download lands in a buffer, and a gigabyte video would take
 * the process with it.
 */
const MAX_BYTES = 250 * 1024 * 1024;

interface FileMeta {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  /** A rendered picture of the first page. The way into a locked document. */
  thumbnailLink?: string;
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
    "Read the actual text contents of almost any file in the student's Drive: Google Docs, " +
    'Slides, Sheets, PDFs, Word and PowerPoint files, zip archives, plain text, and images. ' +
    'Photographed or scanned worksheets are read with OCR, and videos are transcribed. ' +
    'Use the fileId from a Classroom ' +
    'material, or from google_drive_list_files. Call this when they ask you to summarise, ' +
    'explain, or quiz them on a document -- do not guess at contents from a title.',
  inputSchema: readFileInput,

  async execute({ fileId }, ctx) {
    const token = await ctx.google?.getAccessToken('drive');
    if (!token) {
      return unavailable(
        'Drive is not connected. Connect it in Settings to let me read your files.',
      );
    }

    const meta = await googleFetch<FileMeta>(
      `${FILES_URL}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime,createdTime,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),webViewLink,thumbnailLink&supportsAllDrives=true`,
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
    const streams = mimeType.startsWith('video/') || mimeType.startsWith('audio/');
    /*
     * A Google file is exported, not downloaded, and the size Drive reports
     * for one is what it occupies in Drive -- not what its text weighs. Two
     * history revision decks on a real account were 31MB and 67MB of images
     * and were refused as too large, when exporting them as text produces a
     * few kilobytes. The cap was being applied to a number with nothing to do
     * with what was about to be fetched.
     */
    const exported = mimeType.startsWith('application/vnd.google-apps.');

    // Streamed media has its own, much higher ceiling; it never lands in memory.
    if (!streams && !exported && size > MAX_BYTES) {
      return unavailable(`"${name}" is too large to read (${Math.round(size / 1024 / 1024)} MB).`);
    }

    const extracted = await extract(meta, mimeType, token, ctx.signal, ctx.transcriber);
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

/**
 * Read a locked file off the picture Drive renders of it.
 *
 * Returns null when there is no thumbnail or nothing legible in it, so the
 * caller can report the original refusal rather than a second, vaguer one.
 */
async function fromThumbnail(
  meta: FileMeta,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  if (!meta.thumbnailLink) return null;

  // Drive offers a 220-pixel preview by default, which OCR can do nothing
  // with. The size is a parameter on the link, so ask for a legible one.
  const big = meta.thumbnailLink.replace(/=s\d+(-[a-z]+)?$/i, `=s${THUMBNAIL_WIDTH}`);

  try {
    const response = await fetch(big, { ...(signal ? { signal } : {}) });
    if (!response.ok) return null;

    const read = await ocrImage(new Uint8Array(await response.arrayBuffer()));
    return read.ok && read.text.trim() !== '' ? read.text : null;
  } catch {
    // The thumbnail host is not the Drive API and has its own failures. This
    // is already the fallback path, so there is nothing below it to try.
    return null;
  }
}

/** Wide enough that body text survives; Drive renders up to about this. */
const THUMBNAIL_WIDTH = 1600;

async function extract(
  meta: FileMeta,
  mimeType: string,
  token: string,
  signal: AbortSignal | undefined,
  transcriber: AudioTranscriber | undefined,
): Promise<string | ReturnType<typeof unavailable>> {
  const name = meta.name ?? 'Untitled';

  /*
   * A folder is not a document, and refusing it is not the only option.
   *
   * A teacher sharing a whole folder is ordinary, and the vault held two of
   * them as notes saying nothing but "this is a folder" -- one with 22
   * photographs of a robotics build inside. Naming the contents is not the
   * same as reading them, and it is the difference between a dead end and
   * somewhere to go next: the ids travel with the names, so the agent can
   * open any of them.
   */
  if (mimeType === FOLDER_MIME) {
    const children = await googleFetch<{ files?: FileMeta[] }>(
      `${FILES_URL}?q=${encodeURIComponent(`'${meta.id}' in parents and trashed = false`)}` +
        '&pageSize=200&fields=files(id,name,mimeType)' +
        '&supportsAllDrives=true&includeItemsFromAllDrives=true',
      token,
      { ...(signal ? { signal } : {}) },
    );
    if (isUnavailable(children)) return children;

    const inside = children.files ?? [];
    if (inside.length === 0) return unavailable(`"${name}" is a folder with nothing in it.`);

    return [
      `"${name}" is a folder holding ${inside.length} ${inside.length === 1 ? 'item' : 'items'}:`,
      '',
      ...inside.map(
        (child) =>
          `${child.name ?? 'Untitled'} (${describeKind(child.mimeType ?? '')}) — fileId ${child.id}`,
      ),
    ].join('\n');
  }

  const exportable = EXPORT_AS[mimeType];
  if (exportable) {
    const bytes = await googleFetchRaw(
      `${FILES_URL}/${meta.id}/export?mimeType=${encodeURIComponent(exportable.mime)}`,
      token,
      signal,
    );
    if (isUnavailable(bytes)) {
      /*
       * A document whose owner has turned off download, print and copy.
       *
       * Drive then refuses every export -- text and PDF alike -- while still
       * handing out a thumbnail, which is a rendered picture of the page. On a
       * real account one such document exported 403 and its thumbnail came
       * back 200 and 143KB, so OCR can simply read the picture.
       *
       * The first page only, and worth having: a title and an opening
       * paragraph beat a note that says nothing at all.
       */
      const seen = await fromThumbnail(meta, signal);
      return seen ?? bytes;
    }
    return decode(bytes);
  }

  if (mimeType === 'application/pdf') {
    const bytes = await googleFetchRaw(`${FILES_URL}/${meta.id}?alt=media`, token, signal);
    if (isUnavailable(bytes)) return bytes;

    /*
     * OCR gets its own copy, made before anything else touches the bytes.
     *
     * pdf.js takes ownership of the buffer it is handed and detaches it, and
     * both reads were views over the same one -- so the fallback below
     * constructed from a dead buffer and threw. It failed only on scans, which
     * are the exact files OCR exists for, and in production that was part of
     * 196 failures out of 512.
     *
     * A copy rather than a second download: the bytes are already here and
     * capped in size, so this costs memory for the length of one read where
     * the alternative costs another round trip to Google.
     */
    const source = new Uint8Array(bytes);
    const forOcr = source.slice();

    const extracted = await extractPdfText(source);
    if (extracted.ok) return extracted.text;

    if (extracted.reason === 'unreadable') {
      return unavailable(`"${name}" is a PDF I could not read -- it may be password protected.`);
    }

    /*
     * No text layer means a scan, which is exactly what OCR is for. Worth the
     * seconds it costs: scanned worksheets are ordinary in schools, and the
     * alternative is telling a student their homework is unreadable.
     */
    const read = await ocrPdf(forOcr);
    if (!read.ok) return unavailable(describeOcrFailure(read.reason, name));
    return read.text;
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

  if (mimeType.startsWith('image/')) {
    const bytes = await googleFetchRaw(`${FILES_URL}/${meta.id}?alt=media`, token, signal);
    if (isUnavailable(bytes)) return bytes;

    const read = await ocrImage(new Uint8Array(bytes));
    if (!read.ok) return unavailable(describeOcrFailure(read.reason, name));
    return read.text;
  }

  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    if (!transcriber) {
      return unavailable(`I cannot listen to "${name}" -- transcription is not configured.`);
    }
    /*
     * Streamed rather than downloaded into memory. These run to 279MB in one
     * real account, against a 512MB cgroup shared with other services.
     */
    const heard = await transcribeMedia(
      `${FILES_URL}/${meta.id}?alt=media&supportsAllDrives=true`,
      token,
      transcriber,
      signal,
    );
    if (!heard.ok) return unavailable(describeTranscriptionFailure(heard.reason, name));
    return `[Transcript of "${name}", about ${heard.minutes} minutes]\n\n${heard.text}`;
  }

  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

  /*
   * .docx and .pptx are zips of XML, so they need no converter service and no
   * write access to Drive -- just unzip and read. Worth doing precisely
   * because there are only a handful: a student does not care that their one
   * Word handout is an unusual format.
   */
  if (mimeType === DOCX || mimeType === PPTX) {
    const bytes = await googleFetchRaw(`${FILES_URL}/${meta.id}?alt=media`, token, signal);
    if (isUnavailable(bytes)) return bytes;
    try {
      const text =
        mimeType === DOCX ? readDocx(new Uint8Array(bytes)) : readPptx(new Uint8Array(bytes));
      if (text.trim().length === 0) {
        return unavailable(`"${name}" has no text in it -- it may be all images.`);
      }
      return text;
    } catch (cause) {
      return unavailable(
        cause instanceof ArchiveError ? cause.message : `I could not read "${name}".`,
      );
    }
  }

  /*
   * Both spellings. Drive reports a zip uploaded from Windows as
   * application/x-zip-compressed, which is the same format under a second
   * name -- and matching one of them turned a real archive into "I cannot
   * read this yet".
   */
  if (mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') {
    const bytes = await googleFetchRaw(`${FILES_URL}/${meta.id}?alt=media`, token, signal);
    if (isUnavailable(bytes)) return bytes;
    return readArchive(new Uint8Array(bytes), name);
  }

  return unavailable(
    `I cannot read "${name}" yet (${mimeType || 'unknown format'}). I can read Google Docs, ` +
      'Slides, Sheets, PDFs, Word and PowerPoint files, images, and plain text.',
  );
}

/** Extensions worth reading out of an archive as-is. */
const TEXT_IN_ARCHIVE =
  /\.(txt|md|csv|json|xml|ya?ml|py|js|ts|java|c|cpp|h|cs|rb|go|rs|sql|html?|css|ino)$/i;

/**
 * Open an archive and read what is inside it.
 *
 * Teachers post zips of coursework -- this account's are Python files and PDFs
 * for robotics. Listing the filenames and stopping would name the homework
 * without showing any of it, so readable members are read, and everything else
 * is listed so the student knows it is there.
 */
async function readArchive(
  bytes: Uint8Array,
  name: string,
): Promise<string | ReturnType<typeof unavailable>> {
  let entries;
  try {
    entries = readZip(bytes);
  } catch (cause) {
    return unavailable(cause instanceof ArchiveError ? cause.message : `Could not open "${name}".`);
  }

  const parts: string[] = [];
  const listedOnly: string[] = [];
  let budget = MAX_CHARS;

  for (const entry of entries) {
    if (budget <= 0) {
      listedOnly.push(entry.path);
      continue;
    }

    let text: string | null = null;
    if (TEXT_IN_ARCHIVE.test(entry.path)) {
      text = decode(
        entry.bytes.buffer.slice(
          entry.bytes.byteOffset,
          entry.bytes.byteOffset + entry.bytes.byteLength,
        ) as ArrayBuffer,
      );
    } else if (entry.path.toLowerCase().endsWith('.pdf')) {
      const extracted = await extractPdfText(entry.bytes);
      text = extracted.ok ? extracted.text : null;
    }

    if (text === null || text.trim().length === 0) {
      // CAD models, images, binaries. Named rather than silently dropped.
      listedOnly.push(entry.path);
      continue;
    }

    const slice = text.slice(0, budget);
    budget -= slice.length;
    parts.push(`--- ${entry.path} ---\n${slice}`);
  }

  if (parts.length === 0) {
    return unavailable(
      `"${name}" contains ${entries.length} files, but none of them hold readable text: ` +
        `${listedOnly.slice(0, 12).join(', ')}`,
    );
  }

  const listing = listedOnly.length
    ? `\n\n--- also inside, not readable as text ---\n${listedOnly.slice(0, 40).join('\n')}`
    : '';
  return parts.join('\n\n') + listing;
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
  if (search?.trim()) {
    /*
     * Both matchers, because they find different things. Measured against a
     * real school account: `name contains 'Crack the Case'` returned NOTHING
     * for a file that exists and is readable, while `fullText contains` found
     * it. fullText covers the file's content and its name, and reaches files
     * a plain name match does not.
     */
    const term = escapeQuery(search.trim());
    clauses.push(`(name contains '${term}' or fullText contains '${term}')`);
  }

  const result = await googleFetch<{ files?: FileMeta[] }>(
    `${FILES_URL}?q=${encodeURIComponent(clauses.join(' and '))}` +
      '&pageSize=100&orderBy=modifiedTime desc' +
      '&fields=files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress))' +
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
          '&fields=files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress))&supportsAllDrives=true' +
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

/**
 * Every file in the student's Drive, for the vault importer.
 *
 * Separate from listAccessibleFiles, which is what a conversation calls: that
 * one stops at a hundred and returns the four fields a model needs to pick a
 * file. This pages through the lot and asks for the fields that decide how a
 * note is written and in what order files get read -- who owns it, when it
 * last changed, where it sits.
 *
 * The ceiling is a guard against a pathological account, not a sample. A real
 * school account came back with 580.
 */
export async function listAllDriveFiles(
  token: string,
  options: { signal?: AbortSignal; max?: number } = {},
): Promise<DriveFileMeta[] | ReturnType<typeof unavailable>> {
  const max = options.max ?? 5000;
  const files: DriveFileMeta[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: 'trashed = false',
      pageSize: '1000',
      /*
       * owners, because this is the listing the importer uses.
       *
       * The owner was added to the search masks and missed here, which is the
       * only call that builds a vault -- so the one source of teacher names
       * Drive offers reached nothing.
       */
      fields:
        'nextPageToken,files(id,name,mimeType,parents,ownedByMe,modifiedTime,webViewLink,' +
        'owners(displayName,emailAddress))',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const result = await googleFetch<{ files?: DriveFileMeta[]; nextPageToken?: string }>(
      `${FILES_URL}?${params.toString()}`,
      token,
      { ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (isUnavailable(result)) return files.length > 0 ? files : result;

    files.push(...(result.files ?? []));
    pageToken = result.nextPageToken;
  } while (pageToken && files.length < max);

  return files;
}

export interface DriveFileMeta {
  id: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  ownedByMe?: boolean;
  modifiedTime?: string;
  webViewLink?: string;
  /**
   * Who owns it. Drive gives a name and an address, unlike Classroom.
   *
   * The field mask never asked for this, so a source of teacher names sat
   * unread beside a thousand files: a worksheet shared into a course is
   * usually shared by whoever teaches it.
   */
  owners?: { displayName?: string; emailAddress?: string }[];
}
