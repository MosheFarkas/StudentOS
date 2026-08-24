import { isUnavailable } from '../tools/google/client.js';
import { listAllDriveFiles, type DriveFileMeta } from '../tools/google/drive.js';
import type { ToolContext } from '../tools/types.js';
import type { DriveFile } from './drive.js';

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

  return files.map((file) => {
    const path = pathOf(file);
    return {
      fileId: file.id,
      name: file.name ?? 'Untitled',
      mimeType: file.mimeType ?? '',
      ownedByStudent: file.ownedByMe ?? false,
      ...(file.modifiedTime ? { modifiedAt: file.modifiedTime } : {}),
      ...(file.webViewLink ? { link: file.webViewLink } : {}),
      ...(path.length > 0 ? { path } : {}),
    };
  });
}
