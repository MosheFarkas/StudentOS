import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tools/types.js';
import { isUnavailable } from '../tools/google/client.js';
import { collectDriveChanges } from './collect-drive.js';

const ctx = {
  userId: 'u',
  agentId: 'u',
  google: { getAccessToken: async () => 'token', hasScope: () => true },
} as unknown as ToolContext;

afterEach(() => vi.unstubAllGlobals());

describe('collecting what changed in a Drive', () => {
  it('turns a change list into new files with paths, and ids that are gone', async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/changes?')) {
        return new Response(
          JSON.stringify({
            newStartPageToken: '901',
            changes: [
              {
                fileId: 'doc1',
                removed: false,
                file: {
                  id: 'doc1',
                  name: 'Chair project',
                  mimeType: 'application/vnd.google-apps.document',
                  parents: ['folder1'],
                  ownedByMe: true,
                  modifiedTime: '2026-09-07T10:00:00Z',
                },
              },
              { fileId: 'gone1', removed: true },
              {
                fileId: 'bin1',
                removed: false,
                file: { id: 'bin1', name: 'old', mimeType: 'application/pdf', trashed: true },
              },
              {
                fileId: 'folder1',
                removed: false,
                file: {
                  id: 'folder1',
                  name: 'Design 10',
                  mimeType: 'application/vnd.google-apps.folder',
                },
              },
              {
                fileId: 'sc1',
                removed: false,
                file: {
                  id: 'sc1',
                  name: 'Chair project (shortcut)',
                  mimeType: 'application/vnd.google-apps.shortcut',
                },
              },
            ],
          }),
        );
      }
      if (url.includes('/files/folder1?')) {
        return new Response(
          JSON.stringify({
            id: 'folder1',
            name: 'Design 10',
            mimeType: 'application/vnd.google-apps.folder',
          }),
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetch);

    const changes = await collectDriveChanges(ctx, '900');
    if (isUnavailable(changes)) throw new Error(changes.reason);

    expect(changes.pageToken).toBe('901');
    expect(changes.removed.sort()).toEqual(['bin1', 'gone1']);
    expect(changes.changed).toHaveLength(1);
    expect(changes.changed[0]).toMatchObject({
      fileId: 'doc1',
      name: 'Chair project',
      ownedByStudent: true,
      path: ['Design 10'],
      modifiedAt: '2026-09-07T10:00:00Z',
    });
    // A shortcut is a second name for something already here, not a file of its own.
    expect(changes.changed.map((f) => f.fileId)).not.toContain('sc1');
    expect(changes.removed).not.toContain('sc1');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('pageToken=900');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('includeRemoved=true');
  });

  it('reports Drive being unavailable rather than inventing an empty change', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const changes = await collectDriveChanges(ctx, 'stale');
    expect(isUnavailable(changes)).toBe(true);
  });
});
