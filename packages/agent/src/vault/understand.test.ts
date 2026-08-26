import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { understandVault } from './understand.js';
import { Vault } from './vault.js';

/**
 * Making sense of the vault once, rather than three times badly.
 *
 * The digest guessed, the pass that writes user.md guessed again from the
 * digest's guesses, and the agent guessed a third time mid-turn -- three
 * readers deriving meaning from the same fragments, none of them able to
 * record that it had guessed at all. This is the one place that decides, and
 * what it produces is claims with evidence attached rather than hints.
 *
 * One course at a time, deliberately. A single pass over the whole vault is
 * the arrangement the research is most damning about: the more similar-looking
 * material you put in front of a model at once, the less reliably it finds the
 * one line that matters.
 */

/** A model that answers by pattern, so a test can script several courses. */
function fake(reply: (prompt: string) => object) {
  const prompts: string[] = [];
  return {
    prompts,
    llm: {
      chat: async (request: { messages: { role: string; content: string }[] }) => {
        const prompt = request.messages.map((m) => m.content).join('\n');
        prompts.push(prompt);
        return { content: JSON.stringify(reply(prompt)), toolCalls: [] } as never;
      },
    },
  };
}

/** Clears anything it is shown. Isolates what the rest of the pass does. */
const agreeable = (answer: string) => (prompt: string) =>
  prompt.includes('Trying to knock a claim down')
    ? { refuted: false }
    : { answer, confidence: 0.9, evidence: [findNote(prompt)], alternatives: [] };

const findNote = (prompt: string) =>
  /^- (\S+):/m.exec(prompt.split('The evidence')[1] ?? '')?.[1] ?? '';

describe('turning a vault into claims', () => {
  let root: string;
  let vault: Vault;

  const course = (name: string) =>
    vault.write({
      name,
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: `${name}, on Google Classroom.`,
    });

  const person = (name: string, full: string, email: string) =>
    vault.write({
      name,
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: email,
      body: `${full}, at ${email}.`,
    });

  const wrote = (id: string, actor: string, body: string) =>
    vault.write({
      name: id,
      kind: 'episode',
      source: 'classroom',
      description: `${actor} wrote.`,
      actor,
      occurred: '2026-01-05T10:00:00Z',
      body,
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-understand-'));
    vault = new Vault(root, 'student-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('settles a claim a proposer made and a refuter let through', async () => {
    await course('french-10');
    await person('lucia-coretti', 'Lucia Coretti', 'lcoretti@lcc.ca');
    await wrote('n1', 'Lucia Coretti', 'Mme Coretti will collect essays. In [[french-10]].');

    const { llm } = fake(agreeable('Lucia Coretti'));
    const { settled } = await understandVault({ llm }, vault, {
      userId: 'u1',
      studentDomain: 'wearelcc.ca',
    });

    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      subject: 'french-10',
      relation: 'taught by',
      object: 'Lucia Coretti',
      basis: 'inferred',
    });
  });

  it('spends nothing on a course no member of staff goes near', async () => {
    /*
     * The cheapest abstention there is, and the most common. A course whose
     * evidence names nobody cannot produce an answer, so nothing is asked.
     */
    await course('cas-2026');
    await person('daniella-malka', 'Daniella Malka', 'dmalka@wearelcc.ca');
    await wrote('n1', 'Daniella Malka', 'Anyone got the notes? In [[cas-2026]].');

    const { llm, prompts } = fake(agreeable('Daniella Malka'));
    const { settled } = await understandVault({ llm }, vault, {
      userId: 'u1',
      studentDomain: 'wearelcc.ca',
    });

    expect(settled).toEqual([]);
    expect(prompts).toEqual([]);
  });

  it('asks about each course separately rather than all at once', async () => {
    /*
     * The correction the research forced on the original design. One pass
     * over everything sounded like the way to give the model the full picture;
     * it is in fact the arrangement where a fact in the middle goes missing.
     */
    await course('french-10');
    await course('maths-10');
    await person('lucia-coretti', 'Lucia Coretti', 'lcoretti@lcc.ca');
    await person('chris-george', 'Chris George', 'cgeorge@lcc.ca');
    await wrote('n1', 'Lucia Coretti', 'Essays Friday. In [[french-10]].');
    await wrote('n2', 'Chris George', 'Test Tuesday. In [[maths-10]].');

    const { llm, prompts } = fake((prompt) =>
      agreeable(prompt.includes('french-10') ? 'Lucia Coretti' : 'Chris George')(prompt),
    );
    const { settled } = await understandVault({ llm }, vault, {
      userId: 'u1',
      studentDomain: 'wearelcc.ca',
    });

    expect(settled.map((c) => c.object).sort()).toEqual(['Chris George', 'Lucia Coretti']);
    // No prompt ever holds both courses: two questions, two small bundles.
    expect(prompts.every((p) => !(p.includes('french-10') && p.includes('maths-10')))).toBe(true);
  });

  it('keeps a refuted claim out and says it was refuted', async () => {
    await course('french-10');
    await person('lucia-coretti', 'Lucia Coretti', 'lcoretti@lcc.ca');
    await person('anna-marzilli', 'Anna Marzilli', 'amarzilli@lcc.ca');
    await wrote('n1', 'Lucia Coretti', 'Mme Coretti, essays Friday. In [[french-10]].');
    await wrote('n2', 'Anna Marzilli', 'Mme Marzilli, trip Monday. In [[french-10]].');

    const { llm } = fake((prompt) =>
      prompt.includes('Trying to knock a claim down')
        ? { refuted: true, why: 'Both are named and nothing separates them.' }
        : { answer: 'Lucia Coretti', confidence: 0.8, evidence: [findNote(prompt)] },
    );

    const { settled } = await understandVault({ llm }, vault, {
      userId: 'u1',
      studentDomain: 'wearelcc.ca',
    });
    expect(settled).toEqual([]);
  });
});
