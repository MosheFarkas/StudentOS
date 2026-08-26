import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askWhoTeaches, EVIDENCE_LIMIT } from './evidence.js';
import { Vault } from './vault.js';

/**
 * Narrowing before asking, without a model.
 *
 * Handing a model the vault and asking it to work out who teaches French is
 * the failure mode, not the fix. Accuracy on a fact in the middle of a long
 * context collapses, and a school vault is thousands of notes that all look
 * alike -- the worst possible filler, because every one of them is plausibly
 * relevant. The narrowing is arithmetic on links and mail domains, it is exact
 * and free, and it leaves the model a dozen sentences and a closed list of
 * names.
 */

describe('gathering what could answer who teaches a course', () => {
  let root: string;
  let vault: Vault;

  const person = (name: string, full: string, email: string) =>
    vault.write({
      name,
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: email,
      body: `${full}, at ${email}.`,
    });

  const wrote = (day: string, actor: string, body: string) =>
    vault.write({
      name: `2026-01-${day}-note`,
      kind: 'episode',
      source: 'classroom',
      description: `${actor} wrote.`,
      actor,
      occurred: `2026-01-${day}T10:00:00Z`,
      body,
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-evidence-'));
    vault = new Vault(root, 'student-1');
    await vault.write({
      name: 'french-10',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'French 10, on Google Classroom.',
    });
    await person('lucia-coretti', 'Lucia Coretti', 'lcoretti@lcc.ca');
    await person('anna-marzilli', 'Anna Marzilli', 'amarzilli@lcc.ca');
    await person('daniella-malka', 'Daniella Malka', 'dmalka@wearelcc.ca');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('offers only staff as possible answers, never classmates', async () => {
    /*
     * A classmate who emails about one subject and nothing else looks exactly
     * like devotion to that subject, and that is how a Grade 10 student was
     * named the maths teacher. The school puts students on one mail domain
     * and staff on another, which settles it before a model is involved.
     */
    await wrote('01', 'Lucia Coretti', 'Essays Friday. In [[french-10]].');
    await wrote('02', 'Daniella Malka', 'Does anyone have the notes? In [[french-10]].');

    const question = await askWhoTeaches(vault, 'french-10', 'wearelcc.ca');
    expect(question?.candidates).toContain('Lucia Coretti');
    expect(question?.candidates).not.toContain('Daniella Malka');
  });

  it('quotes the sentence a name appears in, not the whole note', async () => {
    // The relevant sentence is the evidence. The rest of the note is the
    // distractor that makes the relevant sentence harder to see.
    await wrote(
      '01',
      'Lucia Coretti',
      'Reminder about the bus for the trip on Thursday, leaving at eight. ' +
        'Mme Coretti will collect the essays on Friday. ' +
        'Bring your permission slips to the office before then. In [[french-10]].',
    );

    const question = await askWhoTeaches(vault, 'french-10', 'wearelcc.ca');
    const quote = question?.evidence[0]?.quote ?? '';
    expect(quote).toContain('collect the essays');
    expect(quote).not.toContain('permission slips');
  });

  it('keeps what a writer says they did, not only where they signed', async () => {
    /*
     * The bug that made the pass abstain on the easiest case in the corpus.
     *
     * A teacher writes "Mr George. The unit test is Tuesday. I have posted the
     * review problems and I will go over them in class Monday." Only the first
     * of those sentences contains the surname, so a filter keeping just the
     * sentences a name appears in handed the model "Mr George." and nothing
     * else -- every word that showed teaching was thrown away as irrelevant,
     * and the model correctly declined to identify a teacher from a signature.
     *
     * Where the writer is the candidate, the note is already about what they
     * did. Narrowing is supposed to remove distraction, not evidence.
     */
    await wrote(
      '01',
      'Lucia Coretti',
      'Mme Coretti. The unit test is Tuesday as scheduled. ' +
        'I have posted the review problems and I will go over them in class Monday. ' +
        'In [[french-10]].',
    );

    const question = await askWhoTeaches(vault, 'french-10', 'wearelcc.ca');
    expect(question?.evidence[0]?.quote).toContain('go over them in class');
  });

  it('asks nothing at all when no member of staff is anywhere near the course', async () => {
    // No candidates means no question, and no question means no model call
    // and no chance of an answer being produced out of nothing.
    await wrote('01', 'Daniella Malka', 'Anyone got the notes? In [[french-10]].');
    expect(await askWhoTeaches(vault, 'french-10', 'wearelcc.ca')).toBeNull();
  });

  it('ignores notes belonging to another course entirely', async () => {
    await vault.write({
      name: 'maths-10',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Maths 10.',
    });
    await wrote('01', 'Lucia Coretti', 'Essays Friday. In [[french-10]].');
    await wrote('02', 'Anna Marzilli', 'Test Tuesday. In [[maths-10]].');

    const question = await askWhoTeaches(vault, 'french-10', 'wearelcc.ca');
    expect(question?.evidence.map((e) => e.note)).toEqual(['2026-01-01-note']);
  });

  it('keeps the bundle small enough to be read carefully', async () => {
    /*
     * Not only about cost. Accuracy on a fact buried in the middle of a long
     * context falls off a cliff, and the drop starts well below the size of
     * anything this vault could hand over unbounded.
     */
    for (let day = 10; day < 40; day++) {
      await wrote(String(day), 'Lucia Coretti', `Notice ${day}. Mme Coretti. In [[french-10]].`);
    }

    const question = await askWhoTeaches(vault, 'french-10', 'wearelcc.ca');
    expect(question?.evidence.length).toBeLessThanOrEqual(EVIDENCE_LIMIT);
  });

  it('says how much it left out rather than trimming quietly', async () => {
    // A bundle that was cut silently reads downstream as the whole story.
    for (let day = 10; day < 40; day++) {
      await wrote(String(day), 'Lucia Coretti', `Notice ${day}. Mme Coretti. In [[french-10]].`);
    }

    const question = await askWhoTeaches(vault, 'french-10', 'wearelcc.ca');
    expect(question?.omitted).toBeGreaterThan(0);
  });

  it('carries the course and the relation it is asking about', async () => {
    await wrote('01', 'Lucia Coretti', 'Essays Friday. In [[french-10]].');

    const question = await askWhoTeaches(vault, 'french-10', 'wearelcc.ca');
    expect(question?.subject).toBe('french-10');
    expect(question?.relation).toBe('taught by');
  });
});
