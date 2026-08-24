import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { readFileContents } from './files.js';

/**
 * Reading what is actually inside the files.
 *
 * The vault knows a worksheet exists, which course it belongs to and which
 * assignment it was attached to -- and nothing whatsoever about what it says.
 * A student asking "what do I need for the titration writeup" gets told a file
 * called "Titration method.pdf" exists, which they could have seen themselves.
 *
 * This is the only part of the bootstrap that is expensive per item, so
 * everything here is about spending that money once: never re-reading a file,
 * never retrying one that cannot be read, and stopping at a limit so the cost
 * is paid over several runs rather than all at once.
 */

const summary = (text: string, inCourse: string[] = []) => ({
  // Typed parameters so a test can inspect what the pass was actually sent --
  // the toolless check reads the request rather than trusting the code.
  chat: vi.fn(async (_request: { messages: unknown[]; tools?: unknown }, _ctx?: unknown) => ({
    content: JSON.stringify({ what: text, kind: 'worksheet', inCourse }),
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop' as const,
  })),
});

describe('reading the files in the vault', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-files-'));
    vault = new Vault(root, 'student-1');

    await vault.write({
      name: 'titration-method',
      kind: 'entity',
      source: 'classroom',
      description: 'File',
      externalId: 'drive-1',
      body: 'Titration method.pdf.\n\nPart of [[chemistry]].',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // `unknown` for the deps, as the mail tests do: a fake chat cannot satisfy
  // the provider's full signature, and pinning it here would be a test that
  // measures vitest's Mock type rather than this pass.
  const run = (deps: unknown, limit?: number) =>
    readFileContents(deps as never, { vault, userId: 'u1', ...(limit ? { limit } : {}) });

  it('puts what a file says into its note', async () => {
    const result = await run({
      llm: summary('Step by step method for the titration, including the safety rules.'),
      read: async () => 'Fill the burette to 0.00 cm3. Wear goggles at all times.',
    });

    expect(result.read).toBe(1);
    const note = await vault.read('entity', 'titration-method');
    expect(note?.body).toContain('safety rules');
    // The links it already had must survive: the summary is added to the note,
    // not written over it.
    expect(note?.body).toContain('[[chemistry]]');
  });

  it('never reads the same file twice', async () => {
    // The expensive half of the whole vault. A pass that re-reads what it has
    // already read costs the same as the first pass, for nothing.
    const deps = {
      llm: summary('A method.'),
      read: vi.fn(async () => 'text'),
    };
    await run(deps);
    const second = await run(deps);

    expect(second.read).toBe(0);
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it('stops at the limit, so the cost is spread over runs', async () => {
    for (const n of [2, 3, 4]) {
      await vault.write({
        name: `file-${n}`,
        kind: 'entity',
        source: 'classroom',
        description: 'File',
        externalId: `drive-${n}`,
        body: `File ${n}.`,
      });
    }

    const result = await run({ llm: summary('Something.'), read: async () => 'text' }, 2);
    expect(result.read).toBe(2);
  });

  it('gives up on a file it cannot read, and does not come back to it', async () => {
    /*
     * A scanned photo with no text, a file the student lost access to, a
     * format nothing can open. Without a record of having tried, every run
     * for the rest of the year tries all of them again.
     */
    const deps = { llm: summary('unused'), read: vi.fn(async () => null) };
    const first = await run(deps);
    expect(first.unreadable).toBe(1);

    const second = await run(deps);
    expect(second.read).toBe(0);
    expect(second.unreadable).toBe(0);
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it('files a loose Drive file under the course it turns out to be about', async () => {
    /*
     * A file out of the student's own Drive arrives with a name and nothing
     * else -- on a real account 459 of 469 of them resolve to no folder at
     * all. The pass that reads it has the file open anyway, so deciding which
     * course it belongs to costs nothing extra, and it is the difference
     * between a loose dot and something on the right thread.
     */
    await vault.write({
      name: 'grade-10-math',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Grade 10 Math.',
    });
    await vault.write({
      name: 'june-exam-study-guide',
      kind: 'entity',
      source: 'drive',
      description: 'File',
      externalId: 'drive-9',
      body: 'June Exam Study Guide.\n\nYours -- you made this.',
    });

    await run({
      llm: summary('Revision questions on quadratics and trigonometry.', ['grade-10-math']),
      read: async () => 'Solve for x. Find the missing angle.',
    });

    expect((await vault.read('entity', 'june-exam-study-guide'))?.body).toContain(
      'Part of [[grade-10-math]]',
    );
  });

  it('will not invent a course that does not exist', async () => {
    // The same rule the mail pass follows: a link may only point at a note
    // that is already there, so an edge always lands somewhere real.
    await run({
      llm: summary('Something.', ['a-course-nobody-has']),
      read: async () => 'text',
    });

    expect((await vault.read('entity', 'titration-method'))?.body).not.toContain('[[a-course');
  });

  it('does not file a note under a course it is already filed under', async () => {
    await vault.write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });

    await run({
      llm: summary('A method.', ['chemistry']),
      read: async () => 'text',
    });

    const body = (await vault.read('entity', 'titration-method'))?.body ?? '';
    expect(body.match(/\[\[chemistry\]\]/g)).toHaveLength(1);
  });

  it('leaves everything that is not a file alone', async () => {
    await vault.write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });

    const deps = { llm: summary('x'), read: vi.fn(async () => 'text') };
    await run(deps);
    expect((await vault.read('entity', 'chemistry'))?.body).toBe('Chemistry.');
  });

  it('tries again when the model is rate limited', async () => {
    /*
     * A real run of 512 files failed 196 of them -- 38 per cent. Retrying 20
     * of those by hand, 16 worked first time, so almost none of it was about
     * the files: it was a per-minute token limit, and a reader with no retry
     * turns "come back shortly" into a permanent failure.
     *
     * The mail pass already had this. It was written there, for this exact
     * reason, and never carried across -- which is why both now share one
     * implementation instead of two that drift.
     */
    let call = 0;
    const llm = {
      chat: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('429 Rate limit reached for gpt-5.6-luna');
        return {
          content: JSON.stringify({ what: 'A method.', kind: 'worksheet', inCourse: [] }),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const,
        };
      }),
    };

    const result = await run({ llm, read: async () => 'text' });
    expect(result.read).toBe(1);
    expect(call).toBe(2);
  });

  it('tries again when reading the file itself fails transiently', async () => {
    // Drive throws too -- a detached buffer, a stalled download. Same answer.
    let call = 0;
    const result = await run({
      llm: summary('Fine.'),
      read: async () => {
        call += 1;
        if (call === 1) throw new Error('503 Service Unavailable');
        return 'text';
      },
    });

    expect(result.read).toBe(1);
  });

  it('does not retry a file the model genuinely cannot answer for', async () => {
    const llm = {
      chat: vi.fn(async () => {
        throw new Error('400 context length exceeded');
      }),
    };
    const result = await run({ llm, read: async () => 'text' });

    expect(result.failed).toBe(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('carries on when one file fails', async () => {
    await vault.write({
      name: 'file-2',
      kind: 'entity',
      source: 'classroom',
      description: 'File',
      externalId: 'drive-2',
      body: 'File 2.',
    });

    const result = await run({
      llm: summary('Fine.'),
      read: async (id: string) => {
        if (id === 'drive-1') throw new Error('Drive is having a moment');
        return 'text';
      },
    });

    expect(result.read).toBe(1);
    expect(result.failed).toBe(1);
  });
});
