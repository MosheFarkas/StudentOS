import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { USER_DOC_LIMIT, writeUserDoc, readUserDoc } from './user-doc.js';

/**
 * The document read before every reply.
 *
 * A wrong sentence here is worse than a wrong answer: an answer is visible and
 * forgotten, this is invisible and permanent, and it shapes how the agent
 * treats a person on every turn until somebody notices.
 */

const llmSaying = (text: string) => ({
  chat: vi.fn(async (_request: { messages: unknown[]; tools?: unknown }, _ctx?: unknown) => ({
    content: text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop' as const,
  })),
});

describe('writing the user document', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-userdoc-'));
    vault = new Vault(root, 'student-1');
    await vault.write({
      name: 'french-10',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'French 10, on Google Classroom.',
    });
    await vault.write({
      name: 'culture-essay',
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      body: 'Culture essay.\n\nPart of [[french-10]].',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes what the model returned, and reads it back', async () => {
    const llm = llmSaying('Lucas is in Grade 10 at Lower Canada College and takes French 10.');
    await writeUserDoc({ llm } as never, { vault, userId: 'u1' });

    expect(await readUserDoc(vault)).toContain('Grade 10 at Lower Canada College');
  });

  it('holds it to the budget, cutting at a sentence', async () => {
    /*
     * Read on every turn, so every character is paid for on every turn. A
     * document cut mid-word leaves the agent reading half a fact and believing
     * it, which is why the cut lands on a sentence.
     */
    const long = 'Lucas takes a subject and it is interesting. '.repeat(80);
    await writeUserDoc({ llm: llmSaying(long) } as never, { vault, userId: 'u1' });

    const written = (await readUserDoc(vault)) ?? '';
    expect(written.length).toBeLessThanOrEqual(USER_DOC_LIMIT);
    expect(written.endsWith('.')).toBe(true);
  });

  it('gives the writer the counts rather than the vault', async () => {
    /*
     * Three and a half thousand notes will not fit in a prompt and would cost
     * a fortune per rebuild if they did.
     *
     * The writer is the last call, not the first. Understanding the vault
     * happens before it and does read note text -- that is the whole job of
     * those passes, each over a bundle of a dozen quotes about one thing. What
     * must not happen is the writer being handed the raw material a second
     * time, on top of the answers it was given.
     */
    const llm = llmSaying('Fine.');
    await writeUserDoc({ llm } as never, { vault, userId: 'u1' });

    const sent = JSON.stringify(llm.chat.mock.calls.at(-1)?.[0]);
    // Named as the school named it, not as the filesystem holds it.
    expect(sent).toContain('French 10');
    expect(sent).not.toContain('Culture essay.');
  });

  it('leaves the old document alone when the model returns nothing usable', async () => {
    /*
     * A blank answer must not blank the document. The agent would carry on
     * with no idea who this student is and nothing would say why.
     */
    await writeUserDoc({ llm: llmSaying('Lucas is in Grade 10.') } as never, {
      vault,
      userId: 'u1',
    });
    await writeUserDoc({ llm: llmSaying('   ') } as never, { vault, userId: 'u1' });

    expect(await readUserDoc(vault)).toContain('Grade 10');
  });

  it('returns nothing for a vault that has never had one written', async () => {
    const empty = new Vault(root, 'nobody');
    expect(await readUserDoc(empty)).toBeNull();
  });

  it('strips markup the writer was told not to use', async () => {
    // Belt and braces: the instruction is clear, and a stray heading would
    // otherwise sit in the system prompt of every conversation for a term.
    await writeUserDoc(
      { llm: llmSaying('# About Lucas\n\n- Takes French 10.\n- **Grade 10**.') } as never,
      { vault, userId: 'u1' },
    );

    const written = (await readUserDoc(vault)) ?? '';
    expect(written).not.toMatch(/^#|^-\s|\*\*/m);
    expect(written).toContain('French 10');
  });
});
