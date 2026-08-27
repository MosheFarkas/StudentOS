import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { readDocument } from './documents.js';
import { writeClassDocs } from './class-doc.js';
import type { CourseVerdict } from './courses.js';

/**
 * A page per class, written from the notes underneath it.
 *
 * The layer that makes the vault answerable. Four thousand notes cannot go in a
 * prompt and nobody would read them; one page per subject can be opened when a
 * question turns out to be about that subject, and says what taking it is like.
 */

const llmSaying = (text: string) => ({
  chat: vi.fn(async (_r: { messages: unknown[]; tools?: unknown }, _c?: unknown) => ({
    content: text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 },
    finishReason: 'stop' as const,
  })),
});

const verdict = (over: Partial<CourseVerdict>): CourseVerdict => ({
  course: 'French A',
  academic: true,
  subject: 'french',
  year: '2026-2027',
  keep: true,
  ...over,
});

describe('writing a page per class', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-classdoc-'));
    vault = new Vault(root, 'student-1');

    for (const [name, title] of [
      ['french-a', 'French A'],
      ['french-b', 'French B'],
    ]) {
      await vault.write({
        name: name as string,
        kind: 'entity',
        source: 'classroom',
        description: 'Course',
        body: `${title}, on Google Classroom.`,
      });
    }
    await vault.write({
      name: 'oral-presentation',
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      body: 'Oral presentation.\nPart of [[french-a]].',
    });
    await vault.write({
      name: 'mme-rivard',
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: 'rivard@school.example',
      body: 'Writes about [[french-a]].',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes one page for a subject taught in two rooms', async () => {
    const llm = llmSaying('# French\n\nTaught by [[mme-rivard]].');

    const result = await writeClassDocs(
      { llm },
      {
        vault,
        userId: 'u-1',
        verdicts: [verdict({ course: 'French A' }), verdict({ course: 'French B' })],
      },
    );

    expect(result.written).toBe(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect((await readDocument(vault, 'class-french'))?.body).toContain('Taught by');
  });

  it('shows the writer what is actually in the course', async () => {
    const llm = llmSaying('# French');
    await writeClassDocs({ llm }, { vault, userId: 'u-1', verdicts: [verdict({})] });

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).toContain('Oral presentation');
    expect(sent).toContain('mme-rivard');
  });

  it('writes nothing for a course the vault has dropped', async () => {
    const llm = llmSaying('# French');

    const result = await writeClassDocs(
      { llm },
      { vault, userId: 'u-1', verdicts: [verdict({ keep: false })] },
    );

    expect(result.written).toBe(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('marks a club as not a subject', async () => {
    await vault.write({
      name: 'model-un',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Model UN, on Google Classroom.',
    });
    const llm = llmSaying('# Model UN');

    await writeClassDocs(
      { llm },
      {
        vault,
        userId: 'u-1',
        verdicts: [verdict({ course: 'Model UN', subject: 'model-un', academic: false })],
      },
    );

    expect((await readDocument(vault, 'class-model-un'))?.description).toContain('not a subject');
  });

  it('does not pay to rewrite a page whose sources have not changed', async () => {
    /*
     * A refresh runs every six hours. Ten classes rewritten each time is forty
     * model calls a day producing prose identical to yesterday's.
     */
    const llm = llmSaying('# French');
    const opts = { vault, userId: 'u-1', verdicts: [verdict({})] };

    await writeClassDocs({ llm }, opts);
    const again = await writeClassDocs({ llm }, opts);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(again.skipped).toBe(1);
  });

  it('rewrites when something in the course has changed', async () => {
    const llm = llmSaying('# French');
    const opts = { vault, userId: 'u-1', verdicts: [verdict({})] };

    await writeClassDocs({ llm }, opts);
    await vault.write({
      name: 'listening-test',
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      body: 'Listening test.\nPart of [[french-a]].',
    });
    await writeClassDocs({ llm }, opts);

    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('leaves the page alone when the writer answers with nothing', async () => {
    // A blank answer must not blank a page. An empty document and one that was
    // never written look the same from the outside.
    const opts = { vault, userId: 'u-1', verdicts: [verdict({})] };
    await writeClassDocs({ llm: llmSaying('# French\n\nReal content.') }, opts);
    await writeClassDocs({ llm: llmSaying('   ') }, { ...opts, verdicts: [verdict({})] });

    expect((await readDocument(vault, 'class-french'))?.body).toContain('Real content');
  });

  it('does not clear every page when Classroom returns nothing at all', async () => {
    /*
     * A transient outage must not empty the vault.
     *
     * With no verdicts there is nothing to write and nothing to compare
     * against, so the removal pass below would read "no subject wants any of
     * these" and delete every class page the student has. Google being briefly
     * unreachable is not the same as a student dropping all their subjects.
     */
    const llm = llmSaying('# French');
    await writeClassDocs({ llm }, { vault, userId: 'u-1', verdicts: [verdict({})] });

    const result = await writeClassDocs({ llm }, { vault, userId: 'u-1', verdicts: [] });

    expect(result.removed).toBe(0);
    expect(await readDocument(vault, 'class-french')).not.toBeNull();
  });

  it('takes away a page for a subject the student no longer takes', async () => {
    const llm = llmSaying('# French');
    await writeClassDocs({ llm }, { vault, userId: 'u-1', verdicts: [verdict({})] });

    await writeClassDocs({ llm }, { vault, userId: 'u-1', verdicts: [verdict({ keep: false })] });

    expect(await readDocument(vault, 'class-french')).toBeNull();
  });
});
