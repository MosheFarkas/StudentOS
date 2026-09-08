import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { importConversation } from './conversation.js';

/**
 * Putting the student's own words on the same timeline as their school.
 *
 * Without this the vault is two stores pretending to be one: Classroom and the
 * inbox on disk, everything the student ever said in Postgres, and no link
 * between them. The promise the vault was built for -- Classroom says Friday,
 * the teacher emailed that it moved, and the student said they had not started
 * -- is two thirds of an answer until their side of it is a node too.
 *
 * Their words are their own, so the episode is source: student and renders
 * without the warning that wraps everything a stranger wrote.
 */

const llmReturning = (content: string) => ({
  chat: vi.fn(async (_r: { messages: unknown[]; tools?: unknown }, _c?: unknown) => ({
    content,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop' as const,
  })),
});

const kept = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    keep: true,
    what: 'The student had not started the Cold War essay two days before it was due.',
    about: ['cold-war-essay'],
    inCourse: ['history'],
    ...over,
  });

const EXCHANGES = [
  'Student: i havent started the cold war essay and its due friday\nAgent: Two days is enough.',
  'Student: i dont even know what my argument is\nAgent: Start from what annoyed you in the reading.',
];

describe('recording a conversation', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-conv-'));
    vault = new Vault(root, 'agent-1');
    // Both, as production has them: Classroom writes the course before the
    // assignment that points at it.
    await vault.write({
      name: 'history',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'History, on Google Classroom.',
    });
    await vault.write({
      name: 'cold-war-essay',
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      body: 'Cold War essay.\n\nPart of [[history]].',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (llm: unknown, exchanges = EXCHANGES, id = 'conv-1') =>
    importConversation({ llm } as never, {
      vault,
      exchanges,
      conversationId: id,
      occurred: '2026-09-19T20:00:00Z',
      userId: 'u1',
    });

  it("writes it as the student's own, not as something imported", async () => {
    await run(llmReturning(kept()));
    const episode = (await vault.list('episode'))[0];

    expect(episode?.source).toBe('student');
    expect(episode?.event).toBe('conversation');
    expect(episode?.actor).toBe('The student');
  });

  it('links it to the work it was about', async () => {
    // The whole reason to do this. A conversation nobody joined to an
    // assignment is a diary entry.
    await run(llmReturning(kept()));
    const body = (await vault.list('episode'))[0]?.body ?? '';

    expect(body).toContain('About [[cold-war-essay]]');
    expect(body).toContain('In [[history]]');
  });

  it('keeps what was actually said', async () => {
    await run(llmReturning(kept()));
    expect((await vault.list('episode'))[0]?.body).toContain('havent started');
  });

  it('records nothing for a conversation that was nothing', async () => {
    // "whats 15% of 240" is not a thing that happened to a person.
    const result = await run(
      llmReturning(JSON.stringify({ keep: false, what: '', about: [], inCourse: [] })),
      ['Student: whats 15% of 240\nAgent: 36.'],
    );

    expect(result.written).toBe(0);
    expect(await vault.list('episode')).toEqual([]);
  });

  it('does not record the same conversation twice', async () => {
    const llm = llmReturning(kept());
    await importConversation({ llm } as never, {
      vault,
      exchanges: EXCHANGES,
      conversationId: 'conv-1',
      occurred: '2026-09-19T20:00:00Z',
      userId: 'u1',
    });
    const second = await importConversation({ llm } as never, {
      vault,
      exchanges: EXCHANGES,
      conversationId: 'conv-1',
      occurred: '2026-09-19T20:00:00Z',
      userId: 'u1',
    });

    expect(second.written).toBe(0);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('never links to a note that does not exist', async () => {
    await run(llmReturning(kept({ about: ['cold-war-essay', 'invented-note'] })));
    expect((await vault.list('episode'))[0]?.body).not.toContain('invented-note');
  });

  it('writes nothing when the pass returns something unparseable', async () => {
    const result = await run(llmReturning('I am not sure what to do with this.'));
    expect(result.written).toBe(0);
  });

  it('shows the pass what the conversation already wrote, so it need not write it again', async () => {
    /*
     * A student who says "my test moved to Friday" mid-conversation now gets
     * that recorded on the spot by vault_write. Hours later this pass reads
     * the same conversation. Without being told, it would record the same
     * fact a second time as a conversation episode -- and the writing rules
     * say one event seen twice is one episode.
     */
    await vault.write({
      name: '2026-09-19-test-moved',
      kind: 'episode',
      source: 'student',
      description: 'The student said the chemistry test moved to Friday.',
      externalId: 'agent-1',
      occurred: '2026-09-19T19:00:00Z',
      actor: 'The student',
      event: 'deadline-changed',
      body: 'The student said the chemistry test moved to Friday.',
    });
    const llm = llmReturning(JSON.stringify({ keep: false, what: '', about: [], inCourse: [] }));

    await importConversation({ llm } as never, {
      vault,
      exchanges: ['Student: my chem test moved to friday\nAgent: Noted.'],
      conversationId: 'conv-9',
      occurred: '2026-09-19T20:00:00Z',
      userId: 'u1',
      agentId: 'agent-1',
    });

    const sent = llm.chat.mock.calls[0]?.[0].messages as { role: string; content: string }[];
    const user = sent.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toMatch(/already recorded by you/i);
    expect(user).toContain('The student said the chemistry test moved to Friday.');
  });

  it('shows only the most recent few of its own writes, newest first, dated', async () => {
    // An agent that has been writing for a year must not hand the pass a
    // year of notes on every hourly rollup.
    for (let day = 1; day <= 12; day += 1) {
      const date = `2026-08-${String(day).padStart(2, '0')}`;
      await vault.write({
        name: `${date}-note`,
        kind: 'episode',
        source: 'student',
        description: `Note from ${date}.`,
        externalId: 'agent-1',
        occurred: `${date}T12:00:00Z`,
        actor: 'The student',
        event: 'other',
        body: `Note from ${date}.`,
      });
    }
    const llm = llmReturning(JSON.stringify({ keep: false, what: '', about: [], inCourse: [] }));

    await importConversation({ llm } as never, {
      vault,
      exchanges: ['Student: hi\nAgent: Hello.'],
      conversationId: 'conv-11',
      occurred: '2026-09-19T20:00:00Z',
      userId: 'u1',
      agentId: 'agent-1',
    });

    const sent = llm.chat.mock.calls[0]?.[0].messages as { role: string; content: string }[];
    const user = sent.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('- 2026-08-12: Note from 2026-08-12.');
    expect(user).toContain('- 2026-08-03: Note from 2026-08-03.');
    expect(user).not.toContain('Note from 2026-08-02.');
    expect(user).not.toContain('Note from 2026-08-01.');
    expect(user.indexOf('2026-08-12')).toBeLessThan(user.indexOf('2026-08-03'));
  });

  it('says nothing about prior writes when there were none', async () => {
    const llm = llmReturning(kept());
    await importConversation({ llm } as never, {
      vault,
      exchanges: EXCHANGES,
      conversationId: 'conv-10',
      occurred: '2026-09-19T20:00:00Z',
      userId: 'u1',
      agentId: 'agent-1',
    });

    const sent = llm.chat.mock.calls[0]?.[0].messages as { role: string; content: string }[];
    const user = sent.find((m) => m.role === 'user')?.content ?? '';
    expect(user).not.toMatch(/already recorded/i);
  });
});
