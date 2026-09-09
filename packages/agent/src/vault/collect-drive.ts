import { isUnavailable } from '../tools/google/client.js';
import {
  fileMeta,
  listAllDriveFiles,
  listChanges,
  type DriveFileMeta,
} from '../tools/google/drive.js';
import { unavailable, type ToolContext, type ToolUnavailable } from '../tools/types.js';
import { SHORTCUT, type DriveFile } from './drive.js';

/**
 * Fetching the student's Drive, and working out where each file sits.
 *
 * The folder path is resolved here rather than in the importer because it
 * needs the whole listing at once: Drive hands back parent ids, and turning
 * those into names means having every folder already.
 *
 * In practice it usually resolves to nothing. On a real account 459 of 469
 * files had no parent this app could see, because per-file Drive access shows
 * the file and not the tree it lives in. It is kept because it costs one pass
 * over a list already in memory, and when it does resolve it is a free edge.
 */

const FOLDER = 'application/vnd.google-apps.folder';

/** Deep enough for any real filing, shallow enough that a loop cannot run. */
const MAX_DEPTH = 8;

export async function collectDriveFiles(ctx: ToolContext): Promise<DriveFile[]> {
  const token = await ctx.google?.getAccessToken('drive');
  if (!token) return [];

  const files = await listAllDriveFiles(token, {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (isUnavailable(files)) return [];

  const folders = new Map(files.filter((f) => f.mimeType === FOLDER).map((f) => [f.id, f]));

  const pathOf = (file: DriveFileMeta): string[] => {
    const parts: string[] = [];
    let at = file.parents?.[0];
    for (let depth = 0; depth < MAX_DEPTH && at; depth += 1) {
      const parent = folders.get(at);
      // A parent this app cannot see. Everything above it is invisible too,
      // so there is nothing further to walk.
      if (!parent) break;
      parts.unshift(parent.name ?? '');
      at = parent.parents?.[0];
    }
    return parts;
  };

  return files.map((file) => toDriveFile(file, pathOf(file)));
}

/** A listing row as the importer wants it, with the folder path already resolved. */
export function toDriveFile(file: DriveFileMeta, path: string[]): DriveFile {
  return {
    fileId: file.id,
    name: file.name ?? 'Untitled',
    mimeType: file.mimeType ?? '',
    ownedByStudent: file.ownedByMe ?? false,
    /*
     * Who owns it, when somebody else does.
     *
     * Drive returns a display name and an address for the owner, which is
     * more than Classroom will say about who posted an announcement. A file
     * shared into a course is usually shared by whoever teaches it.
     */
    ...(file.ownedByMe
      ? {}
      : (() => {
          const owner = file.owners?.[0];
          const named = owner?.displayName ?? owner?.emailAddress;
          return named ? { owner: named } : {};
        })()),
    ...(file.modifiedTime ? { modifiedAt: file.modifiedTime } : {}),
    ...(file.webViewLink ? { link: file.webViewLink } : {}),
    ...(path.length > 0 ? { path } : {}),
  };
}

export interface DriveChanges {
  /** Files created or changed, folders and shortcuts left out. */
  changed: DriveFile[];
  /** Ids of files deleted or trashed. */
  removed: string[];
  /** Where the next call starts. */
  pageToken: string;
}

/**
 * What changed since the last token, for the live sync.
 *
 * A change arrives with parent ids and no names, so the folders a changed
 * file sits in are fetched one at a time and cached for the batch. Walked to
 * the same depth as the full listing: the importer never rewrites a note it
 * has already written, so a path cut short here is a misfiling the slow
 * refresh cannot undo.
 */
export async function collectDriveChanges(
  ctx: ToolContext,
  pageToken: string,
): Promise<DriveChanges | ToolUnavailable> {
  const token = await ctx.google?.getAccessToken('drive');
  if (!token) return unavailable('Google Drive is not connected.');

  const listed = await listChanges(token, pageToken);
  if (isUnavailable(listed)) return listed;

  const removed: string[] = [];
  const metas: DriveFileMeta[] = [];
  for (const change of listed.changes) {
    if (change.removed || change.file?.trashed) removed.push(change.fileId);
    else if (change.file && change.file.mimeType !== FOLDER && change.file.mimeType !== SHORTCUT)
      metas.push(change.file);
  }

  const folders = new Map<string, DriveFileMeta | null>();
  const folder = async (id: string): Promise<DriveFileMeta | null> => {
    if (folders.has(id)) return folders.get(id) ?? null;
    const meta = await fileMeta(token, id);
    const found = isUnavailable(meta) ? null : meta;
    folders.set(id, found);
    return found;
  };
  const pathOf = async (file: DriveFileMeta): Promise<string[]> => {
    const parts: string[] = [];
    let at = file.parents?.[0];
    for (let depth = 0; depth < MAX_DEPTH && at; depth += 1) {
      const parent = await folder(at);
      if (!parent) break;
      parts.unshift(parent.name ?? '');
      at = parent.parents?.[0];
    }
    return parts;
  };

  const changed: DriveFile[] = [];
  for (const meta of metas) changed.push(toDriveFile(meta, await pathOf(meta)));

  return { changed, removed, pageToken: listed.newStartPageToken };
}
