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

const summary = (text: string) => ({
  // Typed parameters so a test can inspect what the pass was actually sent --
  // the toolless check reads the request rather than trusting the code.
  chat: vi.fn(async (_request: { messages: unknown[]; tools?: unknown }, _ctx?: unknown) => ({
    content: JSON.stringify({ what: text, kind: 'worksheet' }),
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
