import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { listDocuments, readDocument, writeDocument } from './documents.js';
import { writePersonDocs } from './person-doc.js';

/**
 * A page per person, and the record that outlasts the course.
 *
 * Everything else about a finished class is filtered out before it reaches the
 * vault. The people are distilled instead, because a teacher outlives the year
 * they taught and may teach this student again -- and in five years this page
 * may be the only thing left saying who taught them Grade 8 science.
 */

const llmSaying = (text: string) => ({
  chat: vi.fn(async (_r: { messages: unknown[]; tools?: unknown }, _c?: unknown) => ({
    content: text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 },
    finishReason: 'stop' as const,
  })),
});

describe('writing a page per person', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-persondoc-'));
    vault = new Vault(root, 'student-1');

    await vault.write({
      name: 'mme-rivard',
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: 'rivard@school.example',
      body: 'Mme Rivard, at rivard@school.example.',
    });
    await vault.write({
      name: '2026-03-02-essay-feedback',
      kind: 'episode',
      source: 'gmail',
      description: 'Mme Rivard commented on the oral.',
      occurred: '2026-03-02T10:00:00.000Z',
      event: 'assignment-graded',
      actor: 'Mme Rivard',
      body: 'She said the oral needed more specific examples.\nBy [[mme-rivard]]',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (llm: unknown, self?: string | null) =>
    writePersonDocs({ llm } as never, { vault, userId: 'u-1', ...(self ? { self } : {}) });

  it('writes a page for a person the vault knows', async () => {
    const result = await run(llmSaying('# Mme Rivard\n\nTeaches French.'));

    expect(result.written).toBe(1);
    expect((await readDocument(vault, 'person-mme-rivard'))?.body).toContain('Teaches French');
  });

  it('shows the writer what that person actually wrote', async () => {
    const llm = llmSaying('# Mme Rivard');
    await run(llm);

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain('more specific examples');
  });

  it('links the note it was written from, whatever the writer wrote', async () => {
    // The only edge joining a page to its evidence, so it is not left to a
    // model to remember.
    await run(llmSaying('# Mme Rivard\n\nA page with no links in it.'));
    expect((await readDocument(vault, 'person-mme-rivard'))?.body).toContain('[[mme-rivard]]');
  });

  it('never writes a page about the student themselves', async () => {
    /*
     * Their own note folds into the page describing them. A second page about
     * them in the third person is the same person written twice.
     */
    await vault.write({
      name: 'lucas-liu',
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: 'lyliu@school.example',
      body: 'Lucas Liu, at lyliu@school.example.',
    });

    await run(llmSaying('# Somebody'), 'lucas-liu');
    expect(await readDocument(vault, 'person-lucas-liu')).toBeNull();
  });

  it('tells the writer plainly when there is nothing but a name', async () => {
    // Most people in a vault appeared on one thread. A page inventing a manner
    // from two automated notifications is worse than one saying only a name.
    await vault.write({
      name: 'unknown-sender',
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: 'x@school.example',
      body: 'Somebody, at x@school.example.',
    });

    const llm = llmSaying('# Somebody');
    await run(llm);

    const briefs = llm.chat.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(briefs.some((brief) => brief.includes('Nothing in the vault mentions them'))).toBe(true);
  });

  it('does not pay to rewrite a page whose sources have not changed', async () => {
    const llm = llmSaying('# Mme Rivard');
    await run(llm);
    const again = await run(llm);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(again.skipped).toBe(1);
  });

  it('rewrites when something new is known about them', async () => {
    const llm = llmSaying('# Mme Rivard');
    await run(llm);

    await vault.write({
      name: '2026-04-01-another',
      kind: 'episode',
      source: 'gmail',
      description: 'Mme Rivard posted work.',
      occurred: '2026-04-01T10:00:00.000Z',
      event: 'assignment-posted',
      body: 'She posted the listening test.\nBy [[mme-rivard]]',
    });
    await run(llm);

    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('leaves a page alone when the writer answers with nothing', async () => {
    await run(llmSaying('# Mme Rivard\n\nReal content.'));
    await run(llmSaying('   '));

    expect((await readDocument(vault, 'person-mme-rivard'))?.body).toContain('Real content');
  });

  it('takes away a page for somebody no longer in the vault', async () => {
    await run(llmSaying('# Mme Rivard'));
    await vault.remove('entity', 'mme-rivard');

    await vault.write({
      name: 'someone-else',
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: 'else@school.example',
      body: 'Someone Else, at else@school.example.',
    });
    const result = await run(llmSaying('# Someone Else'));

    expect(result.removed).toBe(1);
    expect(await readDocument(vault, 'person-mme-rivard')).toBeNull();
  });

  it('does not clear every page when the vault has no people at all', async () => {
    /*
     * An import that failed and a student who knows nobody look identical from
     * here, and only one of the two readings is recoverable.
     */
    await run(llmSaying('# Mme Rivard'));
    await vault.remove('entity', 'mme-rivard');

    const result = await run(llmSaying('# Nobody'));
    expect(result.removed).toBe(0);
    expect(await readDocument(vault, 'person-mme-rivard')).not.toBeNull();
  });

  it('does not touch the pages that are not about people', async () => {
    await writeDocument(vault, { name: 'user', description: 'Them', body: '# Lucas' });
    await writeDocument(vault, { name: 'class-french', description: 'french', body: '# French' });

    await run(llmSaying('# Mme Rivard'));

    const names = (await listDocuments(vault)).map((doc) => doc.name);
    expect(names).toContain('user');
    expect(names).toContain('class-french');
  });
});
