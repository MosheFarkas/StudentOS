import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../vault/vault.js';
import { writeDocument } from '../vault/documents.js';
import { openVaultDocument } from './documents.js';
import type { ToolContext } from './types.js';

/**
 * Opening one of the documents about a student, by name.
 *
 * The counterpart to vault_search and deliberately a separate tool. Search is
 * for the evidence -- thousands of notes, ranked, a handful returned. This is
 * for the eight or so pages written from it, which are not searched for but
 * named: user.md is already in the prompt and its wikilinks say what the rest
 * are called.
 */

describe('vault_open', () => {
  let root: string;
  let vault: Vault;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-vaultopen-'));
    vault = new Vault(root, 'agent-1');
    ctx = { userId: 'u1', agentId: 'agent-1', vault } as ToolContext;

    await writeDocument(vault, {
      name: 'class-french',
      description: 'French, as the vault has it',
      body: '# French\n\nTaught by [[mme-rivard]] and [[m-dupont]].',
    });
    await writeDocument(vault, {
      name: 'school',
      description: 'The school',
      body: '# Lower Canada College\n\nA school in Montreal.',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('opens a document by name', async () => {
    const result = await openVaultDocument.execute({ name: 'class-french' }, ctx);
    expect(result).toContain('Taught by');
  });

  it('says what there is when the name is wrong', async () => {
    /*
     * Discovery costs nothing this way.
     *
     * A list mode would be a second call every time, and a tool description
     * naming the documents would differ per student -- which is what breaks
     * prefix caching for everyone.
     */
    const result = await openVaultDocument.execute({ name: 'francais' }, ctx);

    expect(result).toContain('class-french');
    expect(result).toContain('school');
  });

  it('does not offer the notes underneath as documents', async () => {
    await vault.write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry, on Google Classroom.',
    });

    const result = await openVaultDocument.execute({ name: 'nope' }, ctx);
    expect(result).not.toContain('chemistry');
  });

  it('does not crash on a name that would climb out of the vault', async () => {
    const result = await openVaultDocument.execute({ name: '../../../etc/passwd' }, ctx);
    expect(result).toContain('class-french');
  });

  it('needs no Google scope, because the vault is nobody else’s to grant', () => {
    expect(openVaultDocument.requiredScopes ?? []).toEqual([]);
  });

  it('says so when the vault is not wired up at all', async () => {
    const result = await openVaultDocument.execute({ name: 'school' }, {
      userId: 'u1',
      agentId: 'agent-1',
    } as ToolContext);

    expect(result).toContain('not available');
  });

  it('goes through the same renderer the notes do', async () => {
    // Not for the warning -- a document is ours -- but so that the boundary
    // cannot be forgotten by whoever adds the next reader.
    const result = await openVaultDocument.execute({ name: 'school' }, ctx);
    expect(result).toContain('Lower Canada College');
    expect(result).not.toContain('<untrusted>');
  });
});
