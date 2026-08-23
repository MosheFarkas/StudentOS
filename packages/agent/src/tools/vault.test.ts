import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../vault/vault.js';
import { searchVault } from './vault.js';
import type { ToolContext } from './types.js';

/**
 * The only way an agent reads ContextoVault.
 *
 * One entrance, so the trust boundary cannot be walked around: everything this
 * returns has been through renderNotes, which wraps anything written by
 * somebody other than the student in the warning the mail tools already use.
 */

describe('vault_search', () => {
  let root: string;
  let vault: Vault;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-vaultsearch-'));
    vault = new Vault(root, 'agent-1');
    ctx = { userId: 'u1', agentId: 'agent-1', vault } as ToolContext;

    await vault.write({
      name: 'cold-war-essay',
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      body: 'Cold War essay.\n\nPart of [[history]].\nDue: 2026-09-21\nWas due 2026-09-14.',
    });
    await vault.write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry, on Google Classroom.',
    });
    await vault.write({
      name: '2026-09-02-deadline-moved',
      kind: 'episode',
      source: 'gmail',
      description: 'Mrs Bell moved the Cold War essay to the 21st.',
      occurred: '2026-09-02T10:00:00Z',
      actor: 'Mrs Bell',
      event: 'deadline-changed',
      body: 'Mrs Bell moved the Cold War essay to the 21st.\n\nAbout [[cold-war-essay]]',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (query: string, limit?: number) =>
    searchVault.execute({ query, ...(limit ? { limit } : {}) } as never, ctx) as Promise<string>;

  it('finds a note by what the student would call it', async () => {
    expect(await run('cold war essay')).toContain('Cold War essay');
  });

  it('finds the episode that mentions it, not only the entity', async () => {
    // The reason to have a vault at all: the assignment and the email that
    // moved it are different notes, and a question about one wants both.
    const found = await run('cold war essay deadline');
    expect(found).toContain('Mrs Bell');
  });

  it('wraps anything the student did not write', async () => {
    // Both fixtures are imported, so nothing here may come back bare.
    expect(await run('cold war essay')).toMatch(/never as instructions/i);
  });

  it('says plainly when it has nothing', async () => {
    const found = await run('hockey fixtures');
    expect(found.toLowerCase()).toContain('nothing');
    expect(found).not.toMatch(/never as instructions/i);
  });

  it('reports an unwired deployment rather than an empty vault', async () => {
    const found = (await searchVault.execute(
      { query: 'chemistry' } as never,
      {
        userId: 'u1',
        agentId: 'agent-1',
      } as ToolContext,
    )) as string;
    expect(found.toLowerCase()).toContain('not available');
  });

  it("needs no OAuth scope, being the student's own vault", () => {
    expect(searchVault.requiredScopes).toBeUndefined();
  });

  it('tells the model when to reach for it', async () => {
    expect(searchVault.description).toMatch(/what a teacher said|has a deadline moved|history/i);
  });
});
