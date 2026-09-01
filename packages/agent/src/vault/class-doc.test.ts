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

  it('covers both rooms when a school gives them the same name', async () => {
    /*
     * Two rooms of one subject do not have to be named differently.
     *
     * The importer already handles that -- the second becomes french-2 -- but
     * matching a verdict back to its note on the title alone finds only the
     * first, and everything filed under the second room is left out of the page
     * describing the subject.
     */
    await vault.write({
      name: 'french-2',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'French A, on Google Classroom.',
    });
    await vault.write({
      name: 'listening-test',
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      body: 'Listening test.\nPart of [[french-2]].',
    });

    const llm = llmSaying('# French');
    await writeClassDocs(
      { llm },
      { vault, userId: 'u-1', verdicts: [verdict({ course: 'French A' })] },
    );

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).toContain('Listening test');
    expect(sent).toContain('Oral presentation');
  });

  it('finds a course whose name has a comma in it', async () => {
    /*
     * Found by counting: nine courses, eight pages.
     *
     * The importer writes "<name>, on Google Classroom." as the first line, and
     * the title was recovered by taking everything before the first comma. A
     * course actually called "Le parlement des jeunes, 8-10 avril 2026" lost
     * everything after "jeunes", matched no verdict, and got no page -- while
     * every course without a comma worked, which is why nothing noticed.
     */
    await vault.write({
      name: 'le-parlement',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Le parlement des jeunes, 8-10 avril 2026, on Google Classroom.',
    });

    const llm = llmSaying('# Le parlement des jeunes');
    const result = await writeClassDocs(
      { llm },
      {
        vault,
        userId: 'u-1',
        verdicts: [
          verdict({
            course: 'Le parlement des jeunes, 8-10 avril 2026',
            subject: 'le-parlement-des-jeunes',
            academic: false,
          }),
        ],
      },
    );

    expect(result.written).toBe(1);
  });

  it('shows the writer what is actually in the course', async () => {
    const llm = llmSaying('# French');
    await writeClassDocs({ llm }, { vault, userId: 'u-1', verdicts: [verdict({})] });

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).toContain('Oral presentation');
    expect(sent).toContain('mme-rivard');
  });

  it('holds the writer’s reading to a budget', async () => {
    /*
     * A year of a busy subject does not fit in a prompt.
     *
     * Mail episodes on a real account run to thirteen thousand characters each,
     * and a course can have hundreds of things filed under it. Handing over
     * everything would be a six-figure prompt per class, nine times a build,
     * every six hours.
     */
    for (let i = 0; i < 60; i += 1) {
      await vault.write({
        name: `long-note-${i}`,
        kind: 'episode',
        source: 'gmail',
        description: 'A long message',
        occurred: '2026-03-02T10:00:00.000Z',
        event: 'message',
        body: `In [[french-a]].\n\n## The message\n\n${'x'.repeat(5000)}`,
      });
    }

    const llm = llmSaying('# French');
    await writeClassDocs({ llm }, { vault, userId: 'u-1', verdicts: [verdict({})] });

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent.length).toBeLessThan(60_000);
  });

  it('still shows the course itself when everything else is enormous', async () => {
    // Whatever is cut, the thing the page is about must survive the cut.
    await vault.write({
      name: 'huge',
      kind: 'episode',
      source: 'gmail',
      description: 'A huge message',
      occurred: '2026-03-02T10:00:00.000Z',
      event: 'message',
      body: `In [[french-a]].\n\n${'x'.repeat(100_000)}`,
    });

    const llm = llmSaying('# French');
    await writeClassDocs({ llm }, { vault, userId: 'u-1', verdicts: [verdict({})] });

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain('French A');
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

  it('writes nothing for a course the classifier never answered for', async () => {
    /*
     * A verdict with no subject is the absence of a verdict, not one. Naming a
     * page from the course's own raw title is what put
     * `class-2025-2026-10-science-and-technology-04-st-and-ste` in a real vault
     * -- last year's science, reinstated as a current subject because one
     * course went unanswered in an eighteen-course list.
     */
    const llm = llmSaying('# French');

    const result = await writeClassDocs(
      { llm },
      { vault, userId: 'u-1', verdicts: [verdict({ course: 'French A', subject: null })] },
    );

    expect(result.written).toBe(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('does not clear every page on a build that judged nothing', async () => {
    /*
     * One failed call must not empty a student's vault. A build where no course
     * came back judged looks identical to a student who dropped every subject
     * they take, and only one of the two readings is recoverable.
     */
    await writeClassDocs(
      { llm: llmSaying('# French') },
      {
        vault,
        userId: 'u-1',
        verdicts: [verdict({ course: 'French A' })],
      },
    );

    const result = await writeClassDocs(
      { llm: llmSaying('# French') },
      {
        vault,
        userId: 'u-1',
        verdicts: [verdict({ course: 'French A', subject: null })],
      },
    );

    expect(result.removed).toBe(0);
    expect(await readDocument(vault, 'class-french')).not.toBeNull();
  });

  it('links the rooms it was written from, whatever the writer wrote', async () => {
    /*
     * Not asked for in the prompt, because asked-for is how it went missing.
     *
     * Eight of nine pages on a real account had no link back to the Classroom
     * room they describe -- the ninth did, which is what a model choosing looks
     * like. That link is the only thing joining a page to the evidence under
     * it, so it is written by code.
     */
    const llm = llmSaying('# French\n\nA page with no links in it at all.');
    await writeClassDocs(
      { llm },
      { vault, userId: 'u-1', verdicts: [verdict({ course: 'French A' })] },
    );

    expect((await readDocument(vault, 'class-french'))?.body).toContain('[[french-a]]');
  });

  it('links every room when a subject is taught in more than one', async () => {
    const llm = llmSaying('# French');
    await writeClassDocs(
      { llm },
      {
        vault,
        userId: 'u-1',
        verdicts: [verdict({ course: 'French A' }), verdict({ course: 'French B' })],
      },
    );

    const body = (await readDocument(vault, 'class-french'))?.body ?? '';
    expect(body).toContain('[[french-a]]');
    expect(body).toContain('[[french-b]]');
  });

  it('does not link a room twice when the writer already did', async () => {
    const llm = llmSaying('# French\n\nCovers [[french-a]].');
    await writeClassDocs(
      { llm },
      { vault, userId: 'u-1', verdicts: [verdict({ course: 'French A' })] },
    );

    const body = (await readDocument(vault, 'class-french'))?.body ?? '';
    expect(body.match(/\[\[french-a\]\]/g)).toHaveLength(1);
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
