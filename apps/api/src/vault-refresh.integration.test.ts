import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from './context.js';
import { createUser, grantGoogle, reset, testDb } from './test-support/harness.js';
import { refreshVaultFor } from './vault-refresh.js';

/**
 * The gate in front of every build.
 *
 * The button, the timer and the script all go through refreshVaultFor, so this
 * is the one place a student who is not ready can be refused. Against the real
 * database because the grant IS a row: what the gate reads is the stored scope
 * string, and what Better Auth answers when asked for a token. Two testers had
 * a complete row and a token Google had stopped honouring, and the build wrote
 * them an empty vault with a summary that read like a student with no school.
 */

const CLASSROOM = 'https://www.googleapis.com/auth/classroom.courses.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';

/**
 * A context whose Google answers as told, whose vaults live in a fresh temp
 * directory, and whose model must never be reached -- a build that gets that
 * far has got past the gate.
 */
async function contextWhereGoogle(
  answer: () => Promise<{ accessToken: string | null }>,
): Promise<{ ctx: AppContext; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'contexto-vault-'));
  const ctx = {
    db: await testDb(),
    auth: { api: { getAccessToken: answer } },
    env: { VAULT_ROOT: root },
    llm: {
      resolve: async () => {
        throw new Error('the gate should have stopped this build before the model');
      },
    },
  } as unknown as AppContext;
  return { ctx, root };
}

beforeEach(async () => {
  await reset();
});

describe('refusing to build a student who is not ready', () => {
  it('turns away a dead token with the words to fix it, and writes nothing', async () => {
    const student = await createUser();
    await grantGoogle(student.id, [CLASSROOM, GMAIL, DRIVE]);
    const { ctx, root } = await contextWhereGoogle(async () => {
      throw new Error('invalid_grant');
    });

    expect(await refreshVaultFor(ctx, student.id)).toBe(
      'not ready: Google access expired, sign in again',
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('turns away missing consent without asking Google at all', async () => {
    const student = await createUser();
    await grantGoogle(student.id, [CLASSROOM, GMAIL]);
    let asked = 0;
    const { ctx, root } = await contextWhereGoogle(async () => {
      asked += 1;
      return { accessToken: 'ya29.token' };
    });

    expect(await refreshVaultFor(ctx, student.id)).toBe('not ready: Drive not consented');
    expect(asked).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });
});
