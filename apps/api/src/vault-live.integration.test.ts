import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from '@contexto/agent';
import type { AppContext } from './context.js';
import { createUser, grantGoogle, reset, testDb } from './test-support/harness.js';
import { armWatches, liveSync } from './vault-live.js';
import { syncStateOf, updateSyncState } from './vault-sync-state.js';

/**
 * The live tier against the real row it keeps.
 *
 * Almost everything worth checking here IS the stored state: whether a Drive
 * change token survives a bad minute at Google, what a fresh one replaces,
 * and whether a poll pays for a student it can do nothing for. A mocked
 * database would agree with whatever the code did.
 *
 * Google is a stubbed fetch, and the model must never be reached -- a live
 * sync of nothing that spends a model call is the cost this whole tier exists
 * to avoid.
 */

const CLASSROOM = 'https://www.googleapis.com/auth/classroom.courses.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';

const START_TOKEN = 'https://www.googleapis.com/drive/v3/changes/startPageToken';
const CHANGES = 'https://www.googleapis.com/drive/v3/changes?';

const DRIVE_ONLY = { gmail: false, drive: true };

async function liveContext(apiBaseUrl = 'http://localhost:3210'): Promise<{
  ctx: AppContext;
  root: string;
  /** How many times a token was minted -- a refresh against Google in production. */
  minted: () => number;
}> {
  const root = await mkdtemp(join(tmpdir(), 'contexto-live-'));
  let mints = 0;
  const ctx = {
    db: await testDb(),
    auth: {
      api: {
        getAccessToken: async () => {
          mints += 1;
          return { accessToken: 'ya29.token' };
        },
      },
    },
    env: { VAULT_ROOT: root, API_BASE_URL: apiBaseUrl },
    llm: {
      resolve: async () => {
        throw new Error('a live sync should not have reached the model');
      },
    },
  } as unknown as AppContext;
  return { ctx, root, minted: () => mints };
}

/** A vault that exists, which is what vault.has() asks: one entity note. */
async function seedVault(root: string, userId: string, fileId: string): Promise<Vault> {
  const vault = new Vault(root, userId);
  await vault.write({
    name: 'chair-project',
    kind: 'entity',
    source: 'drive',
    description: 'A design brief the student is writing.',
    externalId: fileId,
    body: 'A design brief.',
  });
  return vault;
}

/** Google, answering only what a test says it will, and failing loudly otherwise. */
function stubGoogle(reply: (url: string) => Response | undefined): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const answer = reply(url);
    if (!answer) throw new Error(`unexpected request: ${url}`);
    return answer;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(async () => {
  await reset();
});

afterEach(() => vi.unstubAllGlobals());

describe('what a live sync refuses to do', () => {
  it('turns away a student who is not ready, without asking Google anything', async () => {
    const student = await createUser();
    await grantGoogle(student.id, [CLASSROOM, GMAIL]);
    const { ctx, root } = await liveContext();
    await seedVault(root, student.id, 'file-1');
    const fetch = stubGoogle(() => undefined);

    expect(await liveSync(ctx, student.id, DRIVE_ONLY)).toBe('not ready: Drive not consented');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops at a student with no vault before it costs a request', async () => {
    /*
     * The poll rings every connected student every few minutes. A student who
     * has never built a vault has nothing to sync into, and finding that out
     * must not cost a token refresh and a listing each time round.
     */
    const student = await createUser();
    await grantGoogle(student.id, [CLASSROOM, GMAIL, DRIVE]);
    const { ctx, minted } = await liveContext();
    const fetch = stubGoogle(() => undefined);

    expect(await liveSync(ctx, student.id, DRIVE_ONLY)).toBe('no vault yet');
    expect(fetch).not.toHaveBeenCalled();
    // Not even the readiness check, which is what a token refresh pays for.
    expect(minted()).toBe(0);
  });
});

describe('the Drive change token', () => {
  it('is armed from the start-token endpoint when there is none', async () => {
    const student = await createUser();
    await grantGoogle(student.id, [CLASSROOM, GMAIL, DRIVE]);
    const { ctx, root } = await liveContext();
    await seedVault(root, student.id, 'file-1');
    stubGoogle((url) =>
      url.startsWith(START_TOKEN)
        ? new Response(JSON.stringify({ startPageToken: '4242' }))
        : undefined,
    );

    expect(await liveSync(ctx, student.id, DRIVE_ONLY)).toBe('drive token armed');
    expect((await syncStateOf(ctx.db, student.id))?.drivePageToken).toBe('4242');
  });

  it('survives Google having a bad minute', async () => {
    /*
     * The change feed is the only path that takes a deleted file out of the
     * vault. A token thrown away on a 500 skips every deletion that happened
     * while it was still good, and nothing later goes looking for them.
     */
    const student = await createUser();
    await grantGoogle(student.id, [CLASSROOM, GMAIL, DRIVE]);
    const { ctx, root } = await liveContext();
    await seedVault(root, student.id, 'file-1');
    await updateSyncState(ctx.db, student.id, { drivePageToken: 'good-token' });
    stubGoogle((url) =>
      url.startsWith(CHANGES) ? new Response('{}', { status: 500 }) : undefined,
    );

    expect(await liveSync(ctx, student.id, DRIVE_ONLY)).toContain('drive unavailable');
    expect((await syncStateOf(ctx.db, student.id))?.drivePageToken).toBe('good-token');
  });

  it('is replaced when Drive says it is gone', async () => {
    const student = await createUser();
    await grantGoogle(student.id, [CLASSROOM, GMAIL, DRIVE]);
    const { ctx, root } = await liveContext();
    await seedVault(root, student.id, 'file-1');
    await updateSyncState(ctx.db, student.id, { drivePageToken: 'ancient' });
    stubGoogle((url) => {
      if (url.startsWith(CHANGES)) return new Response('{}', { status: 410 });
      if (url.startsWith(START_TOKEN)) {
        return new Response(JSON.stringify({ startPageToken: '9001' }));
      }
      return undefined;
    });

    expect(await liveSync(ctx, student.id, DRIVE_ONLY)).toBe('drive token reset');
    expect((await syncStateOf(ctx.db, student.id))?.drivePageToken).toBe('9001');
  });

  it('advances past a deletion, taking the note with it and spending nothing', async () => {
    const student = await createUser();
    await grantGoogle(student.id, [CLASSROOM, GMAIL, DRIVE]);
    const { ctx, root } = await liveContext();
    const vault = await seedVault(root, student.id, 'file-gone');
    await updateSyncState(ctx.db, student.id, { drivePageToken: 'p1' });
    stubGoogle((url) =>
      url.startsWith(CHANGES)
        ? new Response(
            JSON.stringify({
              newStartPageToken: 'p2',
              changes: [{ fileId: 'file-gone', removed: true }],
            }),
          )
        : undefined,
    );

    expect(await liveSync(ctx, student.id, DRIVE_ONLY)).toBe('0 drive files, 0 read, 1 removed');
    expect(await vault.list('entity')).toEqual([]);
    expect((await syncStateOf(ctx.db, student.id))?.drivePageToken).toBe('p2');
  });
});

describe('arming watches', () => {
  it('arms nothing when there is no topic and no https address', async () => {
    // Local development, and the poll timer covers it. Gmail needs a Pub/Sub
    // topic and Drive refuses to post to anything but https.
    const student = await createUser();
    await grantGoogle(student.id, [CLASSROOM, GMAIL, DRIVE]);
    const { ctx } = await liveContext('http://localhost:3210');
    const fetch = stubGoogle(() => undefined);

    await armWatches(ctx, student.id);

    expect(fetch).not.toHaveBeenCalled();
    const state = await syncStateOf(ctx.db, student.id);
    expect(state?.gmailWatchExpiresAt ?? null).toBeNull();
    expect(state?.driveChannelId ?? null).toBeNull();
  });
});
