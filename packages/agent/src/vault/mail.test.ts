import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import { CHUNK, importMail, type SchoolMessage } from './mail.js';

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
      domains: ['school.example'],
    });

  /** A Classroom notification, which names its course above the link to it. */
  const notification = (course: string) =>
    message({
      from: '"Stacey Ottley (Classroom)" <no-reply@classroom.google.com>',
      subject: 'New assignment: Debating motion',
      body: `${course}\nhttps://classroom.google.com/c/abc123`,
    });

  it('brings back a course that only its mail remembers', async () => {
    await run(llmReturning(kept()), [notification('Debating')]);
    expect(await vault.read('entity', 'debating')).not.toBeNull();
  });

  it('does not bring back a course the vault has decided to drop', async () => {
    /*
     * Otherwise the vault ping-pongs.
     *
     * The filter takes last year's history out, and the very next build's mail
     * import reads a year of notifications about it and writes it straight back
     * -- so the course is dropped and recreated for as long as the mail is in
     * range, and neither pass is wrong on its own.
     */
    await importMail({ llm: llmReturning(kept()) } as never, {
      vault,
      messages: [notification('Debating')],
      entities: ['cold-war-essay', 'history'],
      userId: 'u1',
      domains: ['school.example'],
      dropped: ['Debating'],
    });

    expect(await vault.read('entity', 'debating')).toBeNull();
  });

  it('gets episodes onto disk before the last message is extracted', async () => {
    /*
     * A year of mail is a half-hour job, and extracting everything before
     * writing anything means an interruption at minute twenty-nine costs all
     * of it. Because an import skips messages it already has, work that
     * reached disk is work a re-run does not repeat -- so writing as it goes
     * is what makes a long import resumable rather than merely restartable.
     */
    let seen = 0;
    let onDiskByTheEnd = -1;
    const llm = {
      chat: vi.fn(async () => {
        seen += 1;
        if (seen === CHUNK + 1) onDiskByTheEnd = (await vault.list('episode')).length;
        return {
          content: kept(),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const,
        };
      }),
    };

    await run(
      llm,
      Array.from({ length: CHUNK + 4 }, (_, i) =>
        message({ messageId: `m-${i}`, subject: `S${i}` }),
      ),
    );

    expect(onDiskByTheEnd).toBe(CHUNK);
  });

  it('keeps going when one message cannot be extracted', async () => {
    /*
     * A real import of a year of mail died on message six hundred: OpenAI
     * returned one 429, Promise.all rejected, and five hundred and ninety-nine
     * successful extractions went in the bin along with it. Nothing was
     * written, and the run had to start over into the same rate limit.
     */
    let call = 0;
    const llm = {
      chat: vi.fn(async () => {
        call += 1;
        // A 400 rather than a 429, so it stays failed: a retryable error
        // would succeed on the next attempt and prove nothing.
        if (call === 2) throw new Error('400 invalid request');
        return {
          content: kept(),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const,
        };
      }),
    };

    const result = await run(llm, [
      message({ messageId: 'm-1' }),
      message({ messageId: 'm-2', subject: 'Second' }),
      message({ messageId: 'm-3', subject: 'Third' }),
    ]);

    // The two that worked are on disk; the one that failed is counted, not
    // silently dropped and not fatal.
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(1);
    expect(await vault.list('episode')).toHaveLength(2);
  });

  it('tries a rate-limited message again before giving up on it', async () => {
    // A rate limit is a "come back shortly", not a verdict on the message.
    // Treating it as failure throws away mail for a reason that has nothing
    // to do with the mail.
    let call = 0;
    const llm = {
      chat: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('429 rate_limit_exceeded');
        return {
          content: kept(),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const,
        };
      }),
    };

    const result = await run(llm, [message()]);
    expect(result.written).toBe(1);
    expect(call).toBe(2);
  });

  it('does not retry a message the model genuinely could not answer', async () => {
    // Retrying a schema violation just spends the same tokens to get the same
    // answer. Only a rate limit and a server fault are worth going back for.
    const llm = {
      chat: vi.fn(async () => {
        throw new Error('400 invalid request: context length exceeded');
      }),
    };

    const result = await run(llm, [message()]);
    expect(result.skipped).toBe(1);
    expect(llm.chat).toHaveBeenCalledTimes(1);
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

  it('resolves a person by their address, not by how the name was written', async () => {
    /*
     * Found on the first real run: lucas-liu and lucas-yunqi-liu, the same
     * person twice, because the note was named after the model's rendering of
     * the name and that varies between messages. The address does not. This is
     * the entity resolution failure the whole design is supposed to avoid, and
     * it appeared the moment real mail arrived.
     */
    const llm = {
      chat: vi
        .fn(async (_r: { messages: unknown[]; tools?: unknown }, _c?: unknown) => ({
          content: '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const,
        }))
        .mockResolvedValueOnce({
          content: kept({ actor: 'Lucas Liu' }),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const,
        })
        .mockResolvedValueOnce({
          content: kept({ actor: 'Lucas Yunqi Liu' }),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const,
        }),
    };

    await run(llm, [
      message({ messageId: 'm-1', from: 'Lucas Liu <lyliu@school.example>' }),
      message({ messageId: 'm-2', from: '"Liu, Lucas Yunqi" <lyliu@school.example>' }),
    ]);

    const people = (await vault.list('entity')).filter((n) => n.description === 'Person');
    expect(people).toHaveLength(1);
    expect(people[0]?.externalId).toBe('lyliu@school.example');
  });

  it('takes the teacher out of an automated sender rather than dropping it', async () => {
    /*
     * This asserted that no person was made at all, on the grounds that
     * no-reply@classroom.google.com is not a teacher and a note for it would
     * become one of the most-linked nodes in the vault.
     *
     * The danger was real and the remedy was wrong. The address is not a
     * person; the name in front of it is, and it is the only place in this
     * system where a teacher's name sits beside the course they posted in.
     * Discarding the message to avoid the address threw the teacher away with
     * it -- and the model's own idea of the actor here is "Google Classroom",
     * which is why the display name is trusted over it.
     */
    await run(llmReturning(kept({ actor: 'Google Classroom' })), [
      message({
        from: '"Mrs. Irwin (Classroom)" <no-reply@classroom.google.com>',
        subject: 'New announcement: "Bring your books"',
      }),
    ]);

    const people = (await vault.list('entity')).filter((n) => n.description === 'Person');
    expect(people.map((p) => p.name)).toEqual(['mrs-irwin']);
    expect(people.some((p) => (p.externalId ?? '').includes('no-reply'))).toBe(false);
  });

  it('still invents nobody for an ordinary automated sender', async () => {
    // Everything else that mails from a do-not-reply address really is a
    // machine, and a note for it would be linked from half the vault.
    await run(llmReturning(kept({ actor: 'LCC Notices' })), [
      message({ from: '"LCC Notices" <no-reply@lcc.ca>' }),
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
  it('keeps the recipients, which say whether it was meant for this student', async () => {
    /*
     * Gmail returns To and Cc, the read tool passes them through, and the
     * collector dropped both -- so a note written personally to one student
     * and a circular sent to nine hundred people arrived in the vault
     * identical.
     *
     * That difference is the best relevance signal a school inbox has, and it
     * was being thrown away one assignment before it was used.
     */
    await run(llmReturning(kept()), [
      message({ to: 'lyliu@wearelcc.ca', cc: 'parents@wearelcc.ca' }),
    ]);

    const [note] = await vault.list('episode');
    expect(note?.body).toContain('lyliu@wearelcc.ca');
    expect(note?.body).toContain('parents@wearelcc.ca');
  });

  it('credits a Classroom notification to the teacher, not to no-reply', async () => {
    /*
     * "Stacey Ottley (Classroom) <no-reply@classroom.google.com>" is the one
     * place a teacher's name sits beside the course they posted in. Read
     * naively it makes one person called no-reply who teaches everything, and
     * every real teacher stays invisible.
     *
     * The address is worthless here and the display name is the whole point,
     * which is the reverse of every other message in the inbox -- so it is the
     * one case where identity comes from the name.
     */
    await run(llmReturning(kept({ actor: 'Stacey Ottley' })), [
      message({
        from: 'Stacey Ottley (Classroom) <no-reply@classroom.google.com>',
        subject: 'New announcement: "Dear Senior School Students"',
      }),
    ]);

    const people = (await vault.list('entity')).filter((n) => n.description === 'Person');
    expect(people.map((p) => p.name)).toContain('stacey-ottley');
    expect(people.some((p) => (p.externalId ?? '').includes('no-reply'))).toBe(false);
  });

  it('treats a teacher known only from Classroom as staff', async () => {
    // They have no school address anywhere in the mailbox, so the domain rule
    // that separates staff from pupils has nothing to work with. Where we
    // learned of them is recorded instead, and it is not the student domain.
    await run(llmReturning(kept({ actor: 'Stacey Ottley' })), [
      message({
        from: 'Stacey Ottley (Classroom) <no-reply@classroom.google.com>',
        subject: 'New material: "Reading list"',
      }),
    ]);

    const person = await vault.read('entity', 'stacey-ottley');
    expect(person?.externalId).toBe('classroom:stacey-ottley');
  });

  it('does not make a teacher of a classmate who commented', async () => {
    /*
     * Classroom notifies on what students do as well, and the sender line
     * looks identical: "Brady Snyder (Classroom)". Treating every one of them
     * as somebody at the school rebuilds the exact bug the mail-domain rule
     * exists to prevent -- a classmate who turns up beside one subject and is
     * read as teaching it.
     *
     * What separates them is in the subject line. Posting an assignment, an
     * announcement, a material or a grade is something only a teacher can do;
     * leaving a comment is not.
     */
    await run(llmReturning(kept({ actor: 'Brady Snyder' })), [
      message({
        from: '"Brady Snyder (Classroom)" <no-reply@classroom.google.com>',
        subject: 'Added a private comment on "Reading"',
      }),
    ]);

    const people = (await vault.list('entity')).filter((n) => n.description === 'Person');
    expect(people).toEqual([]);
  });

  it('makes a person of somebody who posted an assignment', async () => {
    await run(llmReturning(kept({ actor: 'Keith Chuprun' })), [
      message({
        from: '"Keith Chuprun (Classroom)" <no-reply@classroom.google.com>',
        subject: 'New assignment: "Momentum problems"',
      }),
    ]);

    const people = (await vault.list('entity')).filter((n) => n.description === 'Person');
    expect(people.map((p) => p.name)).toEqual(['keith-chuprun']);
  });

  it('records what Classroom said happened, not what a model made of it', async () => {
    /*
     * "New assignment" in the subject line is Classroom stating a fact about
     * what somebody did. Leaving the event to the pass that summarises the
     * message throws that away and replaces it with a guess, and the event is
     * what tells a later reader that this is a record of teaching rather than
     * somebody being mentioned.
     */
    await run(llmReturning(kept({ actor: 'Amanda Marzilli', event: 'message' })), [
      message({
        from: '"Amanda Marzilli (Classroom)" <no-reply@classroom.google.com>',
        subject: 'New assignment: "Learner Profile"',
      }),
    ]);

    const [note] = await vault.list('episode');
    expect(note?.event).toBe('assignment-posted');
  });

  it('does not make a second person out of a title and a surname', async () => {
    /*
     * Mail calls her Jennifer Irwin; Classroom calls her Mrs. Irwin. Slugged
     * separately those are two people, and the vault ended up holding both --
     * which is the entity-resolution failure this file's own comment says the
     * design exists to avoid, reintroduced by trusting a display name.
     *
     * A surname that already belongs to exactly one person is that person.
     * Where two people share it, nothing is merged and a second note is the
     * honest outcome.
     */
    await run(llmReturning(kept({ actor: 'Jennifer Irwin' })), [
      message({ messageId: 'm-a', from: '"Irwin, Jennifer" <jirwin@school.example>' }),
    ]);
    await run(llmReturning(kept({ actor: 'Mrs. Irwin' })), [
      message({
        messageId: 'm-b',
        from: '"Mrs. Irwin (Classroom)" <no-reply@classroom.google.com>',
        subject: 'New assignment: "Essay"',
      }),
    ]);

    const people = (await vault.list('entity')).filter((n) => n.description === 'Person');
    expect(people.map((p) => p.name)).toEqual(['jennifer-irwin']);
  });

  it('makes a course note for a class Classroom no longer returns', async () => {
    /*
     * A class the school deleted, or archived out of reach, is gone from the
     * API and still has a year of mail about it. That mail could only ever
     * link to courses that already had a note -- "omit rather than guess" --
     * so the reference was dropped in silence: no course, no link, and nothing
     * dangling to show anything had been lost.
     *
     * Every Classroom notification names its course in the body, above the
     * link to it. A class nobody can fetch any more is still fully described
     * by the mail it sent.
     */
    const body =
      'Notification settings\n' +
      '<https://accounts.google.com/AccountChooser?continue=https://classroom.google.com/s?email>\n' +
      'Latin 9 - 2023-2024\n' +
      '<https://accounts.google.com/AccountChooser?continue=https://classroom.google.com/c/NzA1NDQ2>\n' +
      'New assignment\n\nTranslation practice';

    await run(llmReturning(kept({ actor: 'Luc Tremblay', inCourse: [] })), [
      message({
        from: '"Luc Tremblay (Classroom)" <no-reply@classroom.google.com>',
        subject: 'New assignment: "Translation practice"',
        body,
      }),
    ]);

    const courses = (await vault.list('entity')).filter((n) => n.description === 'Course');
    expect(courses.map((c) => c.name)).toEqual(['latin-9-2023-2024']);

    const [episode] = await vault.list('episode');
    expect(episode?.body).toContain('[[latin-9-2023-2024]]');
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
