import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { readDocument } from './documents.js';
import { academicYearEnd, writeSchoolDoc } from './school-doc.js';

/**
 * The one page written from outside the student's own account.
 *
 * Everything else in this vault comes from their Classroom, their Drive and
 * their inbox. Their school as an institution is not in any of those: the vault
 * knows a teacher's name and what they set, and nothing about terms, grading or
 * what the place is. That has to be researched.
 */

const llmReplying = (replies: string[]) => {
  const seen: { webSearch?: unknown }[] = [];
  return {
    seen,
    chat: vi.fn(async (request: { messages: unknown[]; webSearch?: unknown }, _c?: unknown) => {
      seen.push(request);
      return {
        content: replies[seen.length - 1] ?? '',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 },
        finishReason: 'stop' as const,
      };
    }),
  };
};

const RESEARCH = JSON.stringify({
  school: 'Lower Canada College',
  academicYearEnds: '06-20',
  findings: [
    { question: 'When does the year end?', answer: 'Late June.', sources: ['https://lcc.ca'] },
  ],
});

describe('researching a school', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-schooldoc-'));
    vault = new Vault(root, 'student-1');
    await vault.write({
      name: 'french-a',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'French A, on Google Classroom.',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (llm: unknown) =>
    writeSchoolDoc({ llm } as never, { vault, userId: 'u-1', domains: ['school.example'] });

  it('writes the page', async () => {
    const llm = llmReplying([
      'A brief.',
      RESEARCH,
      '# Lower Canada College\n\nA school in Montreal.',
    ]);
    const result = await run(llm);

    expect(result.written).toBe(true);
    expect((await readDocument(vault, 'school'))?.body).toContain('Montreal');
  });

  it('only lets the researching pass reach the web', async () => {
    /*
     * Searches are billed one at a time.
     *
     * The pass that reads the vault has nothing to search for, and the pass
     * that composes the page has already been given everything it needs. Only
     * the middle one has a reason to spend.
     */
    const llm = llmReplying(['A brief.', RESEARCH, '# Lower Canada College']);
    await run(llm);

    expect(llm.seen.map((request) => Boolean(request.webSearch))).toEqual([false, true, false]);
  });

  it('bounds how much searching one pass may do', async () => {
    const llm = llmReplying(['A brief.', RESEARCH, '# Lower Canada College']);
    await run(llm);

    expect(llm.seen[1]?.webSearch).toMatchObject({ maxUses: expect.any(Number) });
  });

  it('keeps the year end where the filter can read it', async () => {
    // The pass that decides which classes are current reads this back. Left in
    // the prose it would have to be recovered with a regex, and one day wrongly.
    const llm = llmReplying(['A brief.', RESEARCH, '# Lower Canada College']);
    await run(llm);

    expect((await readDocument(vault, 'school'))?.yearEnds).toBe('06-20');
  });

  it('records no year end rather than a wrong one', async () => {
    const llm = llmReplying([
      'A brief.',
      JSON.stringify({ school: null, academicYearEnds: null, findings: [] }),
      '# A school',
    ]);
    await run(llm);

    expect((await readDocument(vault, 'school'))?.yearEnds).toBeUndefined();
  });

  it('refuses a year end that is not a month and a day', async () => {
    const llm = llmReplying([
      'A brief.',
      JSON.stringify({ academicYearEnds: 'late June', findings: [] }),
      '# A school',
    ]);
    await run(llm);

    expect((await readDocument(vault, 'school'))?.yearEnds).toBeUndefined();
  });

  it('tells the researcher which domain the school mails from', async () => {
    const llm = llmReplying(['A brief.', RESEARCH, '# Lower Canada College']);
    await run(llm);

    expect(JSON.stringify(llm.seen[1])).toContain('school.example');
  });

  it('leaves an existing page alone when the writer answers with nothing', async () => {
    await run(llmReplying(['A brief.', RESEARCH, '# Lower Canada College\n\nReal content.']));
    const result = await run(llmReplying(['A brief.', RESEARCH, '   ']));

    expect(result.written).toBe(false);
    expect((await readDocument(vault, 'school'))?.body).toContain('Real content');
  });
});

describe('reading the year end back', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-schoolyear-'));
    vault = new Vault(root, 'student-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is null when nothing has researched the school', async () => {
    expect(await academicYearEnd(vault)).toBeNull();
  });

  it('is what the page recorded', async () => {
    const llm = llmReplying(['A brief.', RESEARCH, '# Lower Canada College']);
    await writeSchoolDoc({ llm } as never, { vault, userId: 'u-1' });

    expect(await academicYearEnd(vault)).toBe('06-20');
  });
});
