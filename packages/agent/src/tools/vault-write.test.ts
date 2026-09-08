import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDocument } from '../vault/documents.js';
import { Vault } from '../vault/vault.js';
import { writeVaultNote } from './vault-write.js';
import type { ToolContext } from './types.js';

/**
 * The only way a turn writes into ContextoVault.
 *
 * Two rules live here rather than in the prompt, because a prompt is a claim
 * about behaviour and a tool is a guarantee. A link must point at a note that
 * exists, or the vault fills with knowledge-shaped gaps. And an imported note
 * is never edited, because the next refresh rewrites it and the edit would
 * vanish without anyone knowing it had.
 */
describe('vault_write', () => {
  let root: string;
  let vault: Vault;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-vaultwrite-'));
    vault = new Vault(root, 'student-1');
    ctx = { userId: 'u1', agentId: 'agent-1', vault } as ToolContext;

    await vault.write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry, on Google Classroom.',
    });
    await vault.write({
      name: 'chemistry-test',
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      body: 'Chemistry test.\n\nPart of [[chemistry]].\nDue: 2026-09-18',
    });
    await vault.write({
      name: 'my-tutor',
      kind: 'entity',
      source: 'student',
      description: 'A tutor the student sees',
      externalId: 'agent-1',
      body: 'Sam, on Wednesdays.',
    });
    await writeDocument(vault, {
      name: 'class-chemistry',
      description: 'Chemistry, as the vault has it',
      body: '# Chemistry\n\nTaught by Mr Ali.',
    });
    await vault.write({
      name: '2026-09-01-essay-chat',
      kind: 'episode',
      source: 'student',
      description: 'The student said they had not started the essay.',
      externalId: 'conv-1',
      occurred: '2026-09-01T20:00:00Z',
      actor: 'The student',
      event: 'conversation',
      body: 'The student said they had not started the essay.\n\n## What was said\n\nStudent: i havent started',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (input: Record<string, unknown>, context = ctx) =>
    writeVaultNote.execute(input as never, context) as Promise<string>;

  // The vault now always carries the rollup-style fixture episode too; this
  // narrows list('episode') to what a given test's own calls wrote.
  const writtenEpisodes = async () =>
    (await vault.list('episode')).filter((note) => note.name !== '2026-09-01-essay-chat');

  const episode = {
    kind: 'episode',
    title: 'Chemistry test moved to Friday',
    description: 'The student said the chemistry test moved to Friday the 25th.',
    body: 'The student said the chemistry test moved to Friday the 25th.\n\nAbout [[chemistry-test]]\nIn [[chemistry]]',
    occurred: '2026-09-12T18:30:00+01:00',
    event: 'deadline-changed',
  };

  it('writes an episode the student can find again', async () => {
    const reply = await run(episode);
    const written = (await writtenEpisodes())[0];

    expect(reply).toMatch(/^Wrote episode 2026-09-12-chemistry-test-moved-to-friday/);
    expect(written?.event).toBe('deadline-changed');
    // Normalised to UTC: the vault sorts this field as a string, so every writer stores the same form.
    expect(written?.occurred).toBe('2026-09-12T17:30:00.000Z');
    expect(written?.body).toContain('About [[chemistry-test]]');
  });

  it("marks everything it writes as the student's own, from this conversation", async () => {
    await run(episode);
    const written = (await writtenEpisodes())[0];

    expect(written?.source).toBe('student');
    expect(written?.externalId).toBe('agent-1');
    expect(written?.actor).toBe('The student');
  });

  it('dates an episode now when the model gives no time', async () => {
    const { occurred: _occurred, ...undated } = episode;
    await run(undated);
    const written = (await writtenEpisodes())[0];

    expect(written?.occurred).toBeTruthy();
    expect(written?.name.startsWith(new Date().toISOString().slice(0, 10))).toBe(true);
  });

  it('normalises a date the model wrote in words', async () => {
    // The vault sorts occurred lexicographically; a note dated "Sep 12 2026"
    // would sit above every ISO timestamp for ever.
    await run({ ...episode, occurred: 'Sep 12 2026 18:30 UTC' });
    const written = (await writtenEpisodes())[0];

    expect(written?.occurred).toBe('2026-09-12T18:30:00.000Z');
    expect(written?.name.startsWith('2026-09-12-')).toBe(true);
  });

  it('refuses an episode with no event', async () => {
    const { event: _event, ...eventless } = episode;
    expect(await run(eventless)).toMatch(/^Not written:.*event/i);
    expect(await writtenEpisodes()).toEqual([]);
  });

  it('refuses a link to a note that does not exist, and names it', async () => {
    const reply = await run({
      ...episode,
      body: 'Moved.\n\nAbout [[chem-test]]\nIn [[chemistry]]',
    });

    expect(reply).toMatch(/^Not written:/);
    expect(reply).toContain('[[chem-test]]');
    expect(reply).not.toContain('[[chemistry]]');
    expect(await writtenEpisodes()).toEqual([]);
  });

  it('accepts a link to a page as well as to a note', async () => {
    await run({ ...episode, body: 'Moved.\n\nAbout [[class-chemistry]]' });
    expect(await writtenEpisodes()).toHaveLength(1);
  });

  it('writes an entity for a thing the vault does not have', async () => {
    const reply = await run({
      kind: 'entity',
      title: 'Debating club',
      description: 'A club the student joined',
      body: 'Debating club, Thursdays after school.',
    });

    expect(reply).toMatch(/^Wrote entity debating-club/);
    expect((await vault.read('entity', 'debating-club'))?.source).toBe('student');
  });

  it('suffixes a name that is already taken', async () => {
    await run(episode);
    const reply = await run(episode);
    expect(reply).toMatch(/2026-09-12-chemistry-test-moved-to-friday-2/);
  });

  it('updates a note the student wrote', async () => {
    const reply = await run({
      kind: 'entity',
      name: 'my-tutor',
      title: 'My tutor',
      description: 'A tutor the student sees',
      body: 'Sam, on Wednesdays and now Fridays too.',
    });

    expect(reply).toMatch(/^Updated entity my-tutor/);
    expect((await vault.read('entity', 'my-tutor'))?.body).toContain('Fridays');
  });

  it('keeps the date and actor of an episode it is updating', async () => {
    // A correction to last week's note must not move it to today.
    await run({ ...episode, actor: 'Mr Ali' });
    const { occurred: _occurred, ...update } = episode;
    const reply = await run({
      ...update,
      name: '2026-09-12-chemistry-test-moved-to-friday',
      body: 'The student said the chemistry test moved to Friday the 25th, period 3.\n\nAbout [[chemistry-test]]',
    });
    const written = (await writtenEpisodes())[0];

    expect(reply).toMatch(/^Updated episode 2026-09-12-chemistry-test-moved-to-friday/);
    expect(written?.occurred).toBe('2026-09-12T17:30:00.000Z');
    expect(written?.actor).toBe('Mr Ali');
    expect(written?.body).toContain('period 3');
    expect(await writtenEpisodes()).toHaveLength(1);
  });

  it('refuses to edit an imported note, and says what to do instead', async () => {
    const reply = await run({
      kind: 'entity',
      name: 'chemistry-test',
      title: 'Chemistry test',
      description: 'Assignment',
      body: 'Chemistry test, now Friday.',
    });

    expect(reply).toMatch(/^Not written:/);
    expect(reply).toMatch(/classroom/);
    expect(reply).toMatch(/episode/i);
    expect(reply).toContain('About [[chemistry-test]]');
    expect((await vault.read('entity', 'chemistry-test'))?.body).toContain('Due: 2026-09-18');
  });

  it('refuses to rewrite a record it did not write itself', async () => {
    // The rollup's conversation episodes are the student's own too, and they
    // carry the transcript. A name is not a licence to replace one.
    const reply = await run({
      ...episode,
      name: '2026-09-01-essay-chat',
      body: 'The student said they had started the essay.',
    });

    expect(reply).toMatch(/^Not written:/);
    expect(reply).toMatch(/another pass/i);
    expect((await vault.read('episode', '2026-09-01-essay-chat'))?.body).toContain(
      'havent started',
    );
  });

  it('refuses to update a note that is not there', async () => {
    const reply = await run({ ...episode, name: '2020-01-01-nothing' });
    expect(reply).toMatch(/^Not written:.*no episode called/i);
  });

  it('reports an unwired deployment rather than pretending to write', async () => {
    const reply = await run(episode, { userId: 'u1', agentId: 'agent-1' } as ToolContext);
    expect(reply.toLowerCase()).toContain('not available');
  });

  it('needs no OAuth scope', () => {
    expect(writeVaultNote.requiredScopes).toBeUndefined();
  });

  it('tells the model to load the writing skill first', () => {
    expect(writeVaultNote.description).toMatch(/vault-writing/);
  });
});
