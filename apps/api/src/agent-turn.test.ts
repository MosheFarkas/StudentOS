import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, writeDocument } from '@contexto/agent';
import { vaultFor } from './agent-turn.js';

/**
 * Whether a turn is handed the student's vault.
 *
 * It decides three things at once: whether vault_open and vault_search have
 * anything behind them, whether the reading rules are loaded onto the prompt,
 * and whether the page describing the student is read at all. Getting it wrong
 * is silent -- the agent answers, just without knowing who it is talking to.
 */

describe('deciding whether a turn gets a vault', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-vaultfor-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('hands over a vault with a school in it', async () => {
    await new Vault(root, 'student-1').write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });

    expect(await vaultFor(root, 'student-1')).toBeDefined();
  });

  it('hands over a vault holding only what the student has told it', async () => {
    /*
     * The regression this exists to stop.
     *
     * What a student says is kept as a page now, and it is written for anyone
     * who talks to their agent -- connected school or not. The document it
     * replaced was a column on the agent row, read on every turn regardless.
     * Gating on notes alone left this one being written and never read.
     */
    await writeDocument(new Vault(root, 'student-2'), {
      name: 'chats',
      description: 'What they have told you',
      body: 'They read on a phone and cannot take long answers.',
    });

    expect(await vaultFor(root, 'student-2')).toBeDefined();
  });

  it('hands over nothing for a student who has never imported or said anything', async () => {
    // An empty section costs tokens in the cached prefix on every turn, for
    // every new student, forever.
    expect(await vaultFor(root, 'student-3')).toBeUndefined();
  });

  it('hands over nothing when this deployment has no vaults at all', async () => {
    expect(await vaultFor(undefined, 'student-1')).toBeUndefined();
  });
});
