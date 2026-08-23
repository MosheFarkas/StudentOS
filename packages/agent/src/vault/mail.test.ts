import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { importMail, type SchoolMessage } from './mail.js';

/**
 * Turning school mail into ContextoVault episodes.
 *
 * The expensive half of the bootstrap, and the dangerous one. Every message
 * here was written by somebody who is not the student, and what comes out of
 * this goes into a file the agent will later read.
 *
 * So the containment is structural rather than hopeful. The pass runs with no
 * tools, so a hijacked model cannot act. Its answer is parsed against a schema,
 * so it cannot smuggle prose into a note through a field that was meant to hold
 * a name. And it may only link to entities from a shortlist it was given, so it
 * cannot invent a target.
 */

const message = (over: Partial<SchoolMessage> = {}): SchoolMessage => ({
  messageId: 'm-1',
  from: 'mrs.bell@school.example',
  subject: 'Cold War essay',
  date: '2026-09-02T10:00:00Z',
  body: 'The deadline has moved to Friday the 21st.',
  ...over,
});

const llmReturning = (content: string) => ({
  // Typed parameters so a test can inspect what the pass was actually sent --
  // the toolless check reads the request rather than trusting the code.
  chat: vi.fn(async (_request: { messages: unknown[]; tools?: unknown }, _ctx?: unknown) => ({
    content,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop' as const,
  })),
});

const kept = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    keep: true,
    what: 'Mrs Bell moved the Cold War essay deadline to Friday the 21st.',
    actor: 'Mrs Bell',
    event: 'deadline-changed',
    about: ['cold-war-essay'],
    inCourse: ['history'],
    ...over,
  });

describe('importing school mail', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-mail-'));
    vault = new Vault(root, 'agent-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (llm: unknown, messages: SchoolMessage[], entities = ['cold-war-essay', 'history']) =>
    importMail({ llm } as never, {
      vault,
      messages,
      entities,
      userId: 'u1',
      domain: 'school.example',
    });

  it('writes an episode for a message worth keeping', async () => {
    const result = await run(llmReturning(kept()), [message()]);

    expect(result.written).toBe(1);
    const episodes = await vault.list('episode');
    expect(episodes[0]?.source).toBe('gmail');
    expect(episodes[0]?.body).toContain('Friday the 21st');
  });

  it('links the episode to entities that already exist', async () => {
    // The edge the whole import is for. The email that moved a deadline is
    // only useful joined to the assignment it moved.
    await run(llmReturning(kept()), [message()]);
    expect((await vault.list('episode'))[0]?.body).toContain('[[cold-war-essay]]');
  });

  it('drops a link to something that is not on the shortlist', async () => {
    /*
     * A hijacked pass must not be able to invent a target. Anything outside
     * the list it was shown is discarded rather than written, so a link can
     * only ever point at a note that already exists.
     */
    await run(llmReturning(kept({ relatesTo: ['cold-war-essay', 'made-up-note'] })), [message()]);

    const body = (await vault.list('episode'))[0]?.body ?? '';
    expect(body).toContain('[[cold-war-essay]]');
    expect(body).not.toContain('made-up-note');
  });

  it('records when it happened, who did it, and what kind of thing it was', async () => {
    /*
     * The definition in prompts/vault-writing.md, enforced. Without these a
     * later reader cannot sort by time, filter by person, or tell an
     * assignment being posted from a grade coming back.
     */
    await run(llmReturning(kept()), [message()]);
    const episode = (await vault.list('episode'))[0];

    expect(episode?.occurred).toBe('2026-09-02T10:00:00.000Z');
    expect(episode?.actor).toBe('Mrs Bell');
    expect(episode?.event).toBe('deadline-changed');
    expect(episode?.sourceUrl).toContain('m-1');
  });

  it('keeps the message itself, under a heading', async () => {
    // Full fidelity on disk: the vault is meant to be handed over and still
    // make sense. Rendering is where size gets controlled, not storage.
    await run(llmReturning(kept()), [message({ body: 'The deadline has moved to Friday.' })]);
    const body = (await vault.list('episode'))[0]?.body ?? '';

    expect(body).toContain('Mrs Bell moved the Cold War essay');
    expect(body).toContain('The deadline has moved to Friday.');
  });

  it('distinguishes what an episode is about from the course it is in', async () => {
    // One undifferentiated "Relates to" made a course and an assignment look
    // like the same kind of connection. They are not.
    await run(llmReturning(kept()), [message()]);
    const body = (await vault.list('episode'))[0]?.body ?? '';

    expect(body).toMatch(/About \[\[cold-war-essay\]\]/);
    expect(body).toMatch(/In \[\[history\]\]/);
  });

  it('makes a note for the person who sent it, and links to them', async () => {
    /*
     * "Who sent what" needs somebody to have been sent from. Classroom does
     * not hand over teachers -- listCourses returns an id and a name -- so
     * senders at the school domain are the only place people come from, and
     * they are the most-linked nodes the vault was missing.
     */
    await run(llmReturning(kept()), [message()]);

    const people = (await vault.list('entity')).filter((n) => n.description === 'Person');
    expect(people.map((p) => p.name)).toContain('mrs-bell');
    expect((await vault.list('episode'))[0]?.body).toMatch(/By \[\[mrs-bell\]\]/);
  });

  it('does not invent a person for an automated sender', async () => {
    // no-reply@classroom.google.com is not a teacher, and a note for it would
    // become one of the most-linked nodes in the vault.
    await run(llmReturning(kept({ actor: 'Google Classroom' })), [
      message({ from: '"Mrs. Irwin (Classroom)" <no-reply@classroom.google.com>' }),
    ]);

    const people = (await vault.list('entity')).filter((n) => n.description === 'Person');
    expect(people).toEqual([]);
  });

  it('skips a message the pass judged not to be school', async () => {
    const result = await run(
      llmReturning(JSON.stringify({ keep: false, what: '', relatesTo: [] })),
      [message({ subject: 'Your Amazon order has shipped' })],
    );

    expect(result.written).toBe(0);
    expect(await vault.list('episode')).toEqual([]);
  });

  it('never hands the pass any tools', async () => {
    // Structural containment. A pass that cannot call anything cannot be made
    // to do anything -- the worst a hostile message can achieve is a wrong
    // sentence in a note, which is visible and deletable.
    const llm = llmReturning(kept());
    await run(llm, [message()]);

    const request = llm.chat.mock.calls[0]?.[0] as { tools?: unknown } | undefined;
    expect(request?.tools).toBeUndefined();
  });

  it('keeps two messages that share a subject on the same day', async () => {
    /*
     * Found on a real inbox: twenty episodes written, eighteen files on disk.
     * An episode is named for its day and subject, and Classroom notifications
     * reuse both -- so two records of different things quietly became one, and
     * the count was the only trace. Episodes are meant to be immutable; losing
     * one is losing what happened.
     */
    const result = await run(llmReturning(kept()), [
      message({ messageId: 'm-1' }),
      message({ messageId: 'm-2' }),
    ]);

    expect(result.written).toBe(2);
    const episodes = await vault.list('episode');
    expect(episodes).toHaveLength(2);
    expect(new Set(episodes.map((e) => e.externalId)).size).toBe(2);
  });

  it('writes nothing when the pass returns something unparseable', async () => {
    // A refusal, a truncation, or a model talked into replying in prose all
    // arrive the same way. None of them is a note.
    const result = await run(llmReturning('I cannot help with that.'), [message()]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('writes nothing when the answer is the wrong shape', async () => {
    const result = await run(llmReturning(JSON.stringify({ keep: true, what: 42 })), [message()]);
    expect(result.written).toBe(0);
  });
});

describe('running it again', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-mail-'));
    vault = new Vault(root, 'agent-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does not import the same message twice', async () => {
    // Gmail ids are stable, so a second run is a lookup rather than a guess --
    // the same property that makes the Classroom re-sync exact.
    const llm = llmReturning(kept());
    const deps = { llm } as never;
    const options = { vault, messages: [message()], entities: ['cold-war-essay'], userId: 'u1' };

    await importMail(deps, options);
    const second = await importMail(deps, options);

    expect(second.written).toBe(0);
    expect(await vault.list('episode')).toHaveLength(1);
    // And it did not pay a model call to find that out.
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });
});
