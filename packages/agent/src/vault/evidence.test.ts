import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askWhatTheyDo, askWhoTeaches, EVIDENCE_LIMIT } from './evidence.js';
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

/**
 * Deciding what somebody is, before asking what they did.
 *
 * Every failure left in the corpus was a role failure wearing a different hat.
 * A head of year writes to every class he looks after; a librarian chases
 * overdue books; a colleague covers one lesson; a trainee takes some of them.
 * All four do things that look like teaching, and the sentence that says
 * otherwise is usually in a note about a different course -- so a pass looking
 * at one course cannot find it and concludes, reasonably, that they teach.
 *
 * The words are already there. People say what they are, once, in an
 * appositive after their name, and then never again: "Mr George, Head of Grade
 * 10." That is a convention of institutional mail rather than anything about
 * this school, and it is the only place a role is ever written down.
 */
describe('gathering what could say what somebody does', () => {
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
      name: `2026-02-${day}-note`,
      kind: 'episode',
      source: 'classroom',
      description: `${actor} wrote.`,
      actor,
      occurred: `2026-02-${day}T10:00:00Z`,
      body,
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-roles-'));
    vault = new Vault(root, 'student-1');
    await person('chris-george', 'Chris George', 'cgeorge@lcc.ca');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('offers the words somebody uses about themselves, and nothing else', async () => {
    await wrote(
      '01',
      'Chris George',
      'Mr George, Head of Grade 10. Reports go home Friday. In [[history-10]].',
    );

    const question = await askWhatTheyDo(vault, 'chris-george', 'wearelcc.ca');
    expect(question?.candidates).toEqual(['Head of Grade 10']);
  });

  it('reads a description somebody else wrote about them', async () => {
    // A trainee is introduced once, by the person whose lessons they are
    // taking, and describes themselves as a teacher ever after.
    await person('ada-okonkwo', 'Ada Okonkwo', 'aokonkwo@lcc.ca');
    await wrote(
      '01',
      'Erik Lindqvist',
      'I would like to introduce Miss Okonkwo, who is on teaching placement with us this term. In [[music-10]].',
    );

    const question = await askWhatTheyDo(vault, 'ada-okonkwo', 'wearelcc.ca');
    expect(question?.candidates.join(' ')).toContain('teaching placement');
  });

  it('asks nothing at all when nobody ever says what they are', async () => {
    // Most people never say. No candidates, no question, no model call, and
    // no chance of a role being produced out of nothing.
    await wrote('01', 'Chris George', 'Mr George. The test is Tuesday. In [[maths-10]].');
    expect(await askWhatTheyDo(vault, 'chris-george', 'wearelcc.ca')).toBeNull();
  });

  it('does not mistake an instruction addressed to somebody for a role', async () => {
    // "Mr George, please bring the register" is a comma after a name and is
    // not a description of anybody.
    await wrote('01', 'Anna Bell', 'Mr George, please bring the register. In [[maths-10]].');
    expect(await askWhatTheyDo(vault, 'chris-george', 'wearelcc.ca')).toBeNull();
  });

  it('looks across every course, because a role is stated in only one', async () => {
    /*
     * The whole reason this is asked per person rather than per course. The
     * sentence naming somebody Head of Grade 10 appears once, in whichever
     * class they happened to be writing to that day, and is the governing
     * fact everywhere else.
     */
    await wrote('01', 'Chris George', 'Mr George, Head of Grade 10. Photo day. In [[history-10]].');
    await wrote('02', 'Chris George', 'Mr George. Test Tuesday. In [[maths-10]].');

    const question = await askWhatTheyDo(vault, 'chris-george', 'wearelcc.ca');
    expect(question?.candidates).toEqual(['Head of Grade 10']);
    expect(question?.evidence.length).toBeGreaterThan(1);
  });

  it('tells the reader what the bundle is, since it spans everything', async () => {
    await wrote('01', 'Chris George', 'Mr George, Head of Grade 10. Photo day. In [[history-10]].');
    const question = await askWhatTheyDo(vault, 'chris-george', 'wearelcc.ca');
    expect(question?.guarantees?.join(' ')).toMatch(/Chris George/);
  });
});
