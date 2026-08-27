import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { readDocument, writeDocument } from './documents.js';
import { NOTHING_KEPT_YET, ensureChatsDoc, updateChatsDoc } from './chats-doc.js';

/**
 * What is kept from a student's conversations once they are over.
 *
 * The profile this replaces was per agent, so a student with three agents told
 * each of them separately that they cannot read long answers on a phone. This
 * page is theirs: said once, known everywhere.
 */

const llmSaying = (text: string) => ({
  chat: vi.fn(async (_r: { messages: unknown[]; tools?: unknown }, _c?: unknown) => ({
    content: text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 },
    finishReason: 'stop' as const,
  })),
});

const EXCHANGES = [
  'Student: can you keep answers short, im always on my phone\nAgent: Will do.',
  'Student: i revise best late at night\nAgent: Noted.',
];

describe('keeping what a student has told you', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-chatsdoc-'));
    vault = new Vault(root, 'student-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (llm: unknown, exchanges = EXCHANGES) =>
    updateChatsDoc({ llm } as never, { vault, exchanges, userId: 'u-1' });

  const run2 = (into: Vault, llm: unknown) =>
    updateChatsDoc({ llm } as never, { vault: into, exchanges: EXCHANGES, userId: 'u-1' });

  it('writes the page', async () => {
    const result = await run(llmSaying('# How they like to be answered\n\nShort answers.'));

    expect(result.changed).toBe(true);
    expect((await readDocument(vault, 'chats'))?.body).toContain('Short answers');
  });

  it('leaves the page exactly as it was when nothing durable happened', async () => {
    /*
     * The ordinary outcome.
     *
     * Somebody asks what a word means and leaves. Rewriting the page to say the
     * same thing in different words costs a call and risks losing something in
     * the reshuffle.
     */
    await writeDocument(vault, {
      name: 'chats',
      description: 'What they have said',
      body: 'Short answers.',
    });

    const result = await run(llmSaying('UNCHANGED'));

    expect(result.changed).toBe(false);
    expect((await readDocument(vault, 'chats'))?.body).toBe('Short answers.');
  });

  it('shows the writer the page as it stands, so it can rewrite rather than append', async () => {
    await writeDocument(vault, {
      name: 'chats',
      description: 'What they have said',
      body: 'Revises late.',
    });
    const llm = llmSaying('# Them\n\nRevises late. Wants short answers.');
    await run(llm);

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain('Revises late');
  });

  it('shows the writer what was actually said', async () => {
    const llm = llmSaying('# Them\n\nShort answers.');
    await run(llm);

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain('always on my phone');
  });

  it('does not call a model when there is nothing new to read', async () => {
    const llm = llmSaying('# Them');
    const result = await updateChatsDoc({ llm } as never, { vault, exchanges: [], userId: 'u-1' });

    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
  });

  it('does not blank a page it already has', async () => {
    await writeDocument(vault, {
      name: 'chats',
      description: 'What they have said',
      body: 'Short answers.',
    });
    const result = await run(llmSaying('    '));

    expect(result.changed).toBe(false);
    expect((await readDocument(vault, 'chats'))?.body).toBe('Short answers.');
  });

  it('never saves a model narrating an absence', async () => {
    /*
     * This exact failure reached production once already.
     *
     * The pass this replaces showed a placeholder where the document went and
     * asked for it back untouched if nothing was worth keeping. The first real
     * run returned the placeholder, and it was saved as what the agent knew
     * about a person. Models describe an absence in a dozen ways and any of
     * them stored here is read on every turn afterwards.
     */
    let i = 0;
    for (const answer of [
      '(empty)',
      'Nothing is known about this student yet.',
      'No durable facts were learned.',
      'None.',
    ]) {
      const fresh = new Vault(root, `student-${(i += 1)}`);
      expect((await run2(fresh, llmSaying(answer))).changed).toBe(false);
      expect(await readDocument(fresh, 'chats')).toBeNull();
    }
  });

  it('reports no change when the writer hands the page back as it was', async () => {
    await writeDocument(vault, {
      name: 'chats',
      description: 'What they have said',
      body: 'Short answers.',
    });

    expect((await run(llmSaying('Short answers.'))).changed).toBe(false);
  });

  it('takes a starting point from what was known before, when there is no page yet', async () => {
    /*
     * The migration, and there is no SQL in it.
     *
     * Every student already has per-agent profiles. Handing them to the first
     * write means nobody loses what was learned about them the moment this
     * ships.
     */
    const llm = llmSaying('# Them\n\nShort answers.');
    await updateChatsDoc({ llm } as never, {
      vault,
      exchanges: EXCHANGES,
      userId: 'u-1',
      knownBefore: ['Lucas prefers worked examples.'],
    });

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain('worked examples');
  });

  it('does not go back to what was known before once a page exists', async () => {
    await writeDocument(vault, {
      name: 'chats',
      description: 'What they have said',
      body: 'Revises late.',
    });
    const llm = llmSaying('# Them\n\nRevises late.');
    await updateChatsDoc({ llm } as never, {
      vault,
      exchanges: EXCHANGES,
      userId: 'u-1',
      knownBefore: ['Lucas prefers worked examples.'],
    });

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).not.toContain('worked examples');
  });
});

describe('the page existing before there is anything on it', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-chatsseed-'));
    vault = new Vault(root, 'student-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('makes the page so a vault is never missing one', async () => {
    /*
     * A vault is meant to be a folder somebody can open and see the whole shape
     * of. A page that only appears once a student has said something durable is
     * a hole in that picture for everybody new.
     */
    await ensureChatsDoc(vault);

    expect((await readDocument(vault, 'chats'))?.body).toBe(NOTHING_KEPT_YET);
  });

  it('leaves a page that already says something alone', async () => {
    await writeDocument(vault, {
      name: 'chats',
      description: 'What they have said',
      body: 'They read on a phone.',
    });
    await ensureChatsDoc(vault);

    expect((await readDocument(vault, 'chats'))?.body).toBe('They read on a phone.');
  });

  it('never hands the placeholder to the writer as if it were the page', async () => {
    /*
     * The failure this product has already had once.
     *
     * A placeholder shown in the slot where the document goes came back
     * untouched and was saved as what the agent knew about a person. Seeding
     * the file is only safe while the writer is told the file is empty.
     */
    await ensureChatsDoc(vault);

    const llm = llmSaying('# Them\n\nShort answers.');
    await updateChatsDoc({ llm } as never, { vault, exchanges: EXCHANGES, userId: 'u-1' });

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).not.toContain(NOTHING_KEPT_YET);
    expect(sent).toContain('Nothing has been kept about this student yet');
  });

  it('replaces the placeholder rather than appending to it', async () => {
    await ensureChatsDoc(vault);
    await updateChatsDoc({ llm: llmSaying('They read on a phone.') } as never, {
      vault,
      exchanges: EXCHANGES,
      userId: 'u-1',
    });

    expect((await readDocument(vault, 'chats'))?.body).toBe('They read on a phone.');
  });
});
