import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  askWhatKindOfThing,
  askWhatTheyDo,
  askWhatSchoolThisIs,
  askWhatYearTheyAreIn,
  askWhetherItIsRunning,
  askWhoTeaches,
  EVIDENCE_LIMIT,
} from './evidence.js';
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

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
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

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
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

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
    expect(question?.evidence[0]?.quote).toContain('go over them in class');
  });

  it('asks nothing at all when no member of staff is anywhere near the course', async () => {
    // No candidates means no question, and no question means no model call
    // and no chance of an answer being produced out of nothing.
    await wrote('01', 'Daniella Malka', 'Anyone got the notes? In [[french-10]].');
    expect(await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' })).toBeNull();
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

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
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

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
    expect(question?.evidence.length).toBeLessThanOrEqual(EVIDENCE_LIMIT);
  });

  it('keeps a direct account over a bare mention when the bundle is full', async () => {
    /*
     * The bug that made a corpus of tidy fixtures look solved and a realistic
     * one look broken.
     *
     * Evidence was cut in the order the filesystem happened to list it, under
     * a comment claiming it was newest first. With four notes that is
     * invisible. With thirty ordinary notices from other staff into the same
     * class -- which is what a real course looks like -- the one note where
     * the teacher says what they did fell outside the cap, and the pass
     * declined for want of evidence it had been holding.
     *
     * Somebody writing "I marked these" outranks somebody merely appearing,
     * whatever either one's filename is.
     */
    for (let day = 10; day < 34; day++) {
      await wrote(String(day), 'Anna Marzilli', `Mme Marzilli. Notice ${day}. In [[french-10]].`);
    }
    await wrote(
      '35',
      'Lucia Coretti',
      'Mme Coretti. I marked your essays and I will hand them back in my lesson. In [[french-10]].',
    );

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
    expect(question?.evidence.some((e) => e.quote.includes('I marked your essays'))).toBe(true);
  });

  it('sends a short sharp bundle rather than filling the space available', async () => {
    /*
     * A cap is a ceiling, not a quota.
     *
     * Two notes where the teacher says what they did answer the question
     * completely. Sending ten more that merely mention somebody does not add
     * anything to them -- it makes them harder to read, which is the whole
     * finding about long contexts and the reason this pass narrows at all.
     * Under a hundred and twenty ordinary notices the cover-teacher case began
     * failing consistently: the sentence saying she was covering was in the
     * bundle every time, and buried.
     */
    for (let day = 10; day < 34; day++) {
      await wrote(String(day), 'Anna Marzilli', `Mme Marzilli. Notice ${day}. In [[french-10]].`);
    }
    await wrote('35', 'Lucia Coretti', 'Mme Coretti. I marked your essays. In [[french-10]].');
    await wrote(
      '36',
      'Lucia Coretti',
      'Mme Coretti. My lesson moves to Tuesday. In [[french-10]].',
    );

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
    expect(question?.evidence.length).toBeLessThanOrEqual(4);
    // Both direct accounts survive; they are what the question is about.
    expect(question?.evidence.filter((e) => e.quote.includes('Coretti'))).toHaveLength(2);
  });

  it('still shows the rivals, so a contest cannot go unnoticed', async () => {
    /*
     * Sharpening must not become hiding. The wrong French teacher was picked
     * because a rival reading was never visible to anything that could have
     * weighed it, and a bundle trimmed to only the leading candidate rebuilds
     * exactly that blindness at a different layer.
     *
     * So the strongest evidence goes in whole, and what is left over tops it
     * up to a floor: enough to see who else was around, never enough to bury
     * the answer.
     */
    for (let day = 10; day < 34; day++) {
      await wrote(String(day), 'Anna Marzilli', `Mme Marzilli. Notice ${day}. In [[french-10]].`);
    }
    await wrote('35', 'Lucia Coretti', 'Mme Coretti. I marked your essays. In [[french-10]].');
    await wrote(
      '36',
      'Lucia Coretti',
      'Mme Coretti. My lesson moves to Tuesday. In [[french-10]].',
    );

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
    expect(question?.candidates).toContain('Lucia Coretti');
    expect(question?.candidates).toContain('Anna Marzilli');
  });

  it('dates every quote, because who holds a role changes', async () => {
    /*
     * A course that changed hands is unreadable without dates. One note says
     * "this is my last week, Ms Adeyemi will take over" and another says "I am
     * taking this class from now on" -- which of those is current depends
     * entirely on when each was written, and the bundle used to say nothing
     * about when anything was written.
     *
     * A reader shown both undated concluded, reasonably, that the handover was
     * still in the future and the departing teacher was the current one.
     */
    await wrote('05', 'Lucia Coretti', 'Mme Coretti. I marked your essays. In [[french-10]].');

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
    expect(question?.evidence[0]?.quote).toContain('2026-01-05');
  });

  it('says how much it left out rather than trimming quietly', async () => {
    // A bundle that was cut silently reads downstream as the whole story.
    for (let day = 10; day < 40; day++) {
      await wrote(String(day), 'Lucia Coretti', `Notice ${day}. Mme Coretti. In [[french-10]].`);
    }

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
    expect(question?.omitted).toBeGreaterThan(0);
  });

  it('carries the course and the relation it is asking about', async () => {
    await wrote('01', 'Lucia Coretti', 'Essays Friday. In [[french-10]].');

    const question = await askWhoTeaches(vault, 'french-10', { studentDomain: 'wearelcc.ca' });
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

    const question = await askWhatTheyDo(vault, 'chris-george', { studentDomain: 'wearelcc.ca' });
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

    const question = await askWhatTheyDo(vault, 'ada-okonkwo', { studentDomain: 'wearelcc.ca' });
    expect(question?.candidates.join(' ')).toContain('teaching placement');
  });

  it('keeps the note that describes somebody over thirty that mention them', async () => {
    // The appositive appears once. Everything else is ordinary traffic, and a
    // cap taken off the end of a directory listing throws away the only
    // sentence that answers the question.
    for (let day = 10; day < 34; day++) {
      await wrote(String(day), 'Chris George', `Mr George. Notice ${day}. In [[history-10]].`);
    }
    await wrote(
      '35',
      'Chris George',
      'Mr George, Head of Grade 10. Reports go home Friday. In [[history-10]].',
    );

    const question = await askWhatTheyDo(vault, 'chris-george', {
      studentDomain: 'wearelcc.ca',
    });
    expect(question?.evidence.some((e) => e.quote.includes('Head of Grade 10'))).toBe(true);
  });

  it('asks nothing at all when nobody ever says what they are', async () => {
    // Most people never say. No candidates, no question, no model call, and
    // no chance of a role being produced out of nothing.
    await wrote('01', 'Chris George', 'Mr George. The test is Tuesday. In [[maths-10]].');
    expect(await askWhatTheyDo(vault, 'chris-george', { studentDomain: 'wearelcc.ca' })).toBeNull();
  });

  it('does not mistake an instruction addressed to somebody for a role', async () => {
    // "Mr George, please bring the register" is a comma after a name and is
    // not a description of anybody.
    await wrote('01', 'Anna Bell', 'Mr George, please bring the register. In [[maths-10]].');
    expect(await askWhatTheyDo(vault, 'chris-george', { studentDomain: 'wearelcc.ca' })).toBeNull();
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

    const question = await askWhatTheyDo(vault, 'chris-george', { studentDomain: 'wearelcc.ca' });
    expect(question?.candidates).toEqual(['Head of Grade 10']);
    expect(question?.evidence.length).toBeGreaterThan(1);
  });

  it('tells the reader what the bundle is, since it spans everything', async () => {
    await wrote('01', 'Chris George', 'Mr George, Head of Grade 10. Photo day. In [[history-10]].');
    const question = await askWhatTheyDo(vault, 'chris-george', { studentDomain: 'wearelcc.ca' });
    expect(question?.guarantees?.join(' ')).toMatch(/Chris George/);
  });
});

/**
 * What a thing on Google Classroom actually is.
 *
 * Everything arrives as a "course", which is Google's word and not the
 * school's. Under it sit taught subjects, clubs, houses, form groups, exam
 * cohorts and the group somebody made to send bus times to. The name is not
 * reliable -- this school has a house called French and a subject called
 * French -- and the difference decides whether a teacher question is even
 * worth asking, and whether the thing belongs among somebody's subjects or
 * among their activities.
 *
 * This one question has a small answer set, and offering it closed is not the
 * fixed vocabulary the rest of this file argues against. That argument is
 * about relation types, where the space is open and a list always omits the
 * case that matters. Here the question is one question and the answers are
 * few; where none of them fits, the answer is nothing at all.
 */
describe('gathering what could say what kind of thing a course is', () => {
  let root: string;
  let vault: Vault;

  const course = (name: string, body: string) =>
    vault.write({ name, kind: 'entity', source: 'classroom', description: 'Course', body });

  const wrote = (id: string, body: string) =>
    vault.write({
      name: id,
      kind: 'episode',
      source: 'classroom',
      description: 'Someone wrote.',
      actor: 'Lucia Coretti',
      occurred: '2026-01-05T10:00:00Z',
      body,
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-kind-'));
    vault = new Vault(root, 'student-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('offers the kinds of thing a school group can be', async () => {
    await course('french-10', 'French 10, on Google Classroom.');
    await wrote('n1', 'House points assembly Thursday. In [[french-10]].');

    const question = await askWhatKindOfThing(vault, 'french-10', {});
    expect(question?.candidates).toContain('a taught subject');
    expect(question?.candidates).toContain('a house or form group');
    expect(question?.relation).toBe('is');
  });

  it('shows the name, since the name is usually the best evidence', async () => {
    await course('model-un', 'Model UN, on Google Classroom.');
    await wrote('n1', 'Position papers due before we travel. In [[model-un]].');

    const question = await askWhatKindOfThing(vault, 'model-un', {});
    expect(question?.evidence.some((e) => e.quote.includes('Model UN'))).toBe(true);
  });

  it('warns that the name is not to be trusted on its own', async () => {
    // A house called French and a subject called French are two things, and
    // the whole reason this question exists.
    await course('french-10', 'French 10, on Google Classroom.');
    await wrote('n1', 'House points. In [[french-10]].');

    const question = await askWhatKindOfThing(vault, 'french-10', {});
    expect(question?.guarantees?.join(' ')).toMatch(/name/i);
  });

  it('prefers what is peculiar to this course over what every course gets', async () => {
    /*
     * Boilerplate is the enemy of a characterisation question. Bus times,
     * photo days and locker reminders go to every class in the school, so they
     * say nothing whatever about which class they went to -- and there are
     * far more of them than there are notes about what the class actually
     * does.
     *
     * Sampling evenly gives them a share of the bundle proportional to how
     * many they are, which is exactly backwards. What is worth reading is what
     * this course has and the others do not.
     */
    await course('french-10', 'French 10, on Google Classroom.');
    for (let day = 10; day < 34; day++) {
      await vault.write({
        name: `bus-${day}`,
        kind: 'episode',
        source: 'classroom',
        description: 'Someone wrote.',
        actor: 'Peter Ashworth',
        occurred: `2026-05-${day}T10:00:00Z`,
        body: 'Reminder that the bus for the away fixture leaves at 3.15. In [[french-10]].',
      });
    }
    await vault.write({
      name: 'gala',
      kind: 'episode',
      source: 'classroom',
      description: 'Someone wrote.',
      actor: 'Lucia Coretti',
      occurred: '2026-05-11T10:00:00Z',
      body: 'House points assembly Thursday. All four houses compete in the gala. In [[french-10]].',
    });

    const question = await askWhatKindOfThing(vault, 'french-10', {});
    const quotes = question?.evidence.map((e) => e.quote).join(' ') ?? '';
    expect(quotes).toContain('houses compete');
    /*
     * And the boilerplate does not come along for the ride. Twenty-four
     * identical notices tell a reader nothing except how many of them there
     * are, and a bundle mostly made of them reads as an administrative group
     * whatever else is in it.
     *
     * Five: the course's own name, which is always the first thing shown, and
     * a floor of four notes beneath it.
     */
    expect(question?.evidence.length).toBeLessThanOrEqual(5);
  });

  it('says what each of the answers it offers actually means', async () => {
    /*
     * A closed list of answers with no definitions makes the reader invent the
     * boundaries, and then object that the one it wants is missing. Asked
     * whether a course was running, a pass refused to say finished on the
     * grounds that it might be "on its summer holiday, a status not among the
     * offered alternatives" -- a fair complaint about a list nobody had
     * explained.
     */
    await course('french-10', 'French 10, on Google Classroom.');
    await wrote('n1', 'Something happened. In [[french-10]].');

    const question = await askWhatKindOfThing(vault, 'french-10', {});
    const said = question?.guarantees?.join(' ') ?? '';
    for (const option of question?.candidates ?? []) expect(said).toContain(option);
  });

  it('samples the whole life of a course, not its last fortnight', async () => {
    /*
     * What kind of thing something is is a question about the whole of it. A
     * bundle taken from the most recent notes describes whatever the course
     * was doing in June, and in June every course is doing exams and notices.
     */
    await course('chemistry-10', 'Chemistry 10, on Google Classroom.');
    await vault.write({
      name: 'first',
      kind: 'episode',
      source: 'classroom',
      description: 'Someone wrote.',
      actor: 'Anna Bell',
      occurred: '2025-09-05T10:00:00Z',
      body: 'Mrs Bell. Welcome, we begin with the periodic table. In [[chemistry-10]].',
    });
    for (let day = 10; day < 34; day++) {
      await vault.write({
        name: `mid-${day}`,
        kind: 'episode',
        source: 'classroom',
        description: 'Someone wrote.',
        actor: 'Anna Bell',
        occurred: `2026-05-${day}T10:00:00Z`,
        body: `Notice ${day}. In [[chemistry-10]].`,
      });
    }

    const question = await askWhatKindOfThing(vault, 'chemistry-10', {});
    const quotes = question?.evidence.map((e) => e.quote).join(' ') ?? '';
    expect(quotes).toContain('periodic table');
  });

  it('asks nothing about a course nothing has ever happened in', async () => {
    await course('empty-shell', 'Empty, on Google Classroom.');
    expect(await askWhatKindOfThing(vault, 'empty-shell', {})).toBeNull();
  });
});

/**
 * Whether a course is happening now.
 *
 * A document written in late August had a student "preparing for the history
 * exam and completing an IB MYP Personal Project" -- one finished the previous
 * November, the other in February. Every note in both was dated, and nothing
 * in the pass that wrote it had any idea what day it was.
 *
 * A model has no clock, so it is told the date. What it does with it is real
 * reasoning and not arithmetic: a course quiet since June is over if today is
 * October and merely on holiday if today is July, and no threshold in days
 * gets that right on both sides of a summer.
 */
describe('gathering what could say whether a course is running', () => {
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

  const on = (id: string, day: string, body: string) =>
    vault.write({
      name: id,
      kind: 'episode',
      source: 'classroom',
      description: 'Someone wrote.',
      actor: 'Lucia Coretti',
      occurred: `${day}T10:00:00Z`,
      body,
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-running-'));
    vault = new Vault(root, 'student-1');
    await course('history-10');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('tells the reader what day it is, because nothing else does', async () => {
    await on('n1', '2025-11-20', 'Exam revision. In [[history-10]].');

    const question = await askWhetherItIsRunning(vault, 'history-10', { today: '2026-08-26' });
    expect(question?.guarantees?.join(' ')).toContain('2026-08-26');
  });

  it('carries the first and last time anything happened, with dates', async () => {
    await on('n1', '2025-09-05', 'Welcome to the course. In [[history-10]].');
    await on('n2', '2025-11-20', 'Exam revision. In [[history-10]].');

    const question = await askWhetherItIsRunning(vault, 'history-10', { today: '2026-08-26' });
    const quotes = question?.evidence.map((e) => e.quote).join(' ') ?? '';
    expect(quotes).toContain('2025-09-05');
    expect(quotes).toContain('2025-11-20');
  });

  it('offers running, finished and not started', async () => {
    await on('n1', '2025-11-20', 'Exam revision. In [[history-10]].');

    const question = await askWhetherItIsRunning(vault, 'history-10', { today: '2026-08-26' });
    expect(question?.candidates).toEqual(['running', 'finished', 'not yet started']);
  });

  it('says when the rest of the school was still going', async () => {
    /*
     * Silence means nothing on its own. A course that stopped in November is
     * finished if everything else ran on until June, and merely on holiday if
     * everything else stopped in November too.
     *
     * Without that comparison a reader is right to refuse: shown one course
     * that went quiet, it cannot tell whether the course ended or the school
     * did, and it said so -- "they do not establish the course's school year,
     * its end date, or that it will not resume".
     */
    await on('n1', '2025-11-20', 'Exam revision. In [[history-10]].');
    await course('french-10');
    await on('n2', '2026-06-10', 'Last lesson before the summer. In [[french-10]].');

    const question = await askWhetherItIsRunning(vault, 'history-10', { today: '2026-08-26' });
    expect(question?.guarantees?.join(' ')).toContain('2026-06-10');
  });

  it('asks nothing when nothing in the course is dated', async () => {
    // Undated notes cannot say when anything happened, and a question with no
    // temporal evidence is one where any answer is a guess.
    await vault.write({
      name: 'n1',
      kind: 'episode',
      source: 'classroom',
      description: 'Someone wrote.',
      actor: 'Lucia Coretti',
      body: 'Something. In [[history-10]].',
    });
    expect(await askWhetherItIsRunning(vault, 'history-10', { today: '2026-08-26' })).toBeNull();
  });
});

/**
 * Which year the student is in.
 *
 * The first sentence of the document the agent reads before every reply is
 * their name, their year and their school, and the year was being read off
 * course slugs -- "grade-10-math-2025-2026" -- by a pass with no evidence and
 * no way to decline. A student who takes one class with an older cohort, or
 * whose vault holds a course named for the year they are about to enter, gets
 * a wrong answer stated as flatly as a right one.
 *
 * A school writes the year down constantly, in mail to the whole school about
 * every year but this one. That is the difficulty: the words are everywhere
 * and most of them are about somebody else.
 */
describe('gathering what could say which year the student is in', () => {
  let root: string;
  let vault: Vault;

  const wrote = (id: string, body: string) =>
    vault.write({
      name: id,
      kind: 'episode',
      source: 'classroom',
      description: 'Someone wrote.',
      actor: 'Chris George',
      occurred: '2026-02-01T10:00:00Z',
      body,
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-year-'));
    vault = new Vault(root, 'student-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('offers the year-shaped phrases people actually wrote', async () => {
    await wrote('n1', 'Mr George, Head of Grade 10. Reports go home Friday.');

    const question = await askWhatYearTheyAreIn(vault, 'the-student', {});
    expect(question?.candidates).toContain('Grade 10');
  });

  it('offers every year mentioned, including the ones about other people', async () => {
    /*
     * The whole difficulty. A school's mail names every year in it, and most
     * of those sentences are about somebody else -- a graduation dinner for
     * the year above, an open evening for the year below. Hiding the rivals
     * would leave a reader with one plausible answer and no way to see it was
     * a choice.
     */
    await wrote('n1', 'Mr George, Head of Grade 10. Reports go home Friday.');
    await wrote('n2', 'Grade 11 graduation dinner is on June 20th. All welcome.');

    const question = await askWhatYearTheyAreIn(vault, 'the-student', {});
    expect(question?.candidates).toEqual(expect.arrayContaining(['Grade 10', 'Grade 11']));
  });

  it('reads the other ways a school writes a year', async () => {
    await wrote('n1', 'Year 9 students should collect their timetables.');
    const question = await askWhatYearTheyAreIn(vault, 'the-student', {});
    expect(question?.candidates).toContain('Year 9');
  });

  it('asks nothing when nobody ever writes a year down', async () => {
    await wrote('n1', 'The test is on Tuesday, bring a calculator.');
    expect(await askWhatYearTheyAreIn(vault, 'the-student', {})).toBeNull();
  });

  it("says the records are the student's own, because they are", async () => {
    /*
     * The third time the same bug: a reader refuses on grounds the system
     * could have closed and did not.
     *
     * Shown "Head of Grade 10, reports go home Friday for this class", two
     * refuters objected that it never says this student is in that class.
     * They were right on what they could see. The vault is built from the
     * student's own Classroom and their own mail -- a note attached to a class
     * is a class they are enrolled in -- and nothing had told them.
     */
    await wrote('n1', 'Mr George, Head of Grade 10. Reports go home Friday for this class.');
    const question = await askWhatYearTheyAreIn(vault, 'the-student', {});
    expect(question?.guarantees?.join(' ')).toMatch(/their own|enrolled/i);
  });

  it('warns that most of these sentences are about other people', async () => {
    await wrote('n1', 'Mr George, Head of Grade 10. Reports go home Friday.');
    const question = await askWhatYearTheyAreIn(vault, 'the-student', {});
    expect(question?.guarantees?.join(' ')).toMatch(/other years|somebody else|not about them/i);
  });
});

/**
 * Which school this is.
 *
 * The other half of the first sentence, and the half that was being answered
 * out of the model's own memory: it was shown a mail domain and told to name
 * the school "only if you actually recognise it". Recognising a domain is not
 * reading, it is recall, and recall is where a confident wrong answer comes
 * from -- there is no evidence behind it to check and nothing to refute.
 *
 * The name is in the vault, written by people, dozens of times. What marks it
 * out from every other capitalised phrase is that everybody uses it: a
 * person's name appears in their own mail, and the school's appears in
 * everybody's.
 */
describe('gathering what could say which school this is', () => {
  let root: string;
  let vault: Vault;

  const wrote = (id: string, actor: string, body: string) =>
    vault.write({
      name: id,
      kind: 'episode',
      source: 'gmail',
      description: `${actor} wrote.`,
      actor,
      occurred: '2026-02-01T10:00:00Z',
      body,
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-school-'));
    vault = new Vault(root, 'student-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('offers a name that many different people use', async () => {
    await wrote('n1', 'Anna Bell', 'Welcome back to Lower Canada College for the new term.');
    await wrote('n2', 'Chris George', 'Lower Canada College reports go home on Friday.');
    await wrote('n3', 'Gillian Shadley', 'The Lower Canada College open evening is next week.');

    const question = await askWhatSchoolThisIs(vault, 'the-student', {});
    expect(question?.candidates).toContain('Lower Canada College');
  });

  it('does not mistake one person for the institution', async () => {
    /*
     * A name that appears in a great many notes written by one person is that
     * person signing their mail. A name that appears in notes by many
     * different people is a thing they all belong to.
     */
    await wrote('n1', 'Gillian Shadley', 'Gillian Shadley here, essays due Friday.');
    await wrote('n2', 'Gillian Shadley', 'Gillian Shadley again, bring your books.');
    await wrote('n3', 'Gillian Shadley', 'Gillian Shadley, the test is Tuesday.');
    await wrote('n4', 'Anna Bell', 'Welcome back to Lower Canada College.');
    await wrote('n5', 'Chris George', 'Lower Canada College reports go home Friday.');

    const question = await askWhatSchoolThisIs(vault, 'the-student', {});
    expect(question?.candidates[0]).toBe('Lower Canada College');
  });

  it('asks nothing when no name recurs across different writers', async () => {
    await wrote('n1', 'Anna Bell', 'The test is on Tuesday, bring a calculator.');
    expect(await askWhatSchoolThisIs(vault, 'the-student', {})).toBeNull();
  });

  it('tells the reader not to answer from what it already knows', async () => {
    // The failure this replaces is recall, not misreading. A model that
    // recognises a domain will name a school with nothing behind it.
    await wrote('n1', 'Anna Bell', 'Welcome to Lower Canada College.');
    await wrote('n2', 'Chris George', 'Lower Canada College reports go home Friday.');

    const question = await askWhatSchoolThisIs(vault, 'the-student', {});
    expect(question?.guarantees?.join(' ')).toMatch(/already know|recognise|memory/i);
  });
});
