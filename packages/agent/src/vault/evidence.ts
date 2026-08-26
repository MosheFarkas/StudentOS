import type { Question } from './interpret.js';
import type { Evidence } from './claims.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * Working out what could possibly answer a question, before asking it.
 *
 * The instinct that produced every wrong answer here was to give a model more
 * and hope it sorted the rest out. It does the opposite. A fact sitting in the
 * middle of a long context is found far less reliably than the same fact in a
 * short one, and the material that hurts most is the kind that looks relevant
 * without being it -- which is the entire contents of a school vault, where
 * three thousand notes all concern the same twenty people and nineteen
 * courses.
 *
 * So the narrowing happens here, in arithmetic over links and mail domains. It
 * is exact, it is free, and it cannot hallucinate. What reaches a model is a
 * closed list of names and a dozen sentences, which is a question small enough
 * to be answered carefully.
 */

/**
 * How many quotes go in one bundle.
 *
 * Chosen well under where retrieval accuracy starts to sag rather than at the
 * largest size that still fits: the aim is a bundle that gets read properly,
 * not one that fits.
 */
export const EVIDENCE_LIMIT = 12;

/** Quotes are sentences, and a sentence that runs longer than this is a page. */
const QUOTE_LIMIT = 240;

/**
 * Who could be teaching a course, and what the vault says about them there.
 *
 * Null when nobody could be, which is the common case and a good outcome: no
 * candidates means no question, no model call, and no opportunity for a name
 * to be produced out of nothing.
 */
interface Staff {
  /** The note's name, so a claim can point at it. */
  note: string;
  name: string;
  surname: string;
}

/*
 * Staff, by mail domain, and nothing else.
 *
 * This school puts students on one domain and staff on another, and that
 * single fact does more work than any amount of reasoning about who writes the
 * most mail. Without it a Grade 10 student who emailed only ever about maths
 * was named the maths teacher -- she looked devoted to one subject, which is
 * what struggling with one subject looks like.
 */
function staffIn(entities: readonly VaultNote[], studentDomain?: string): Staff[] {
  return entities
    .filter((n) => n.description === 'Person' && n.externalId)
    .filter((n) => !studentDomain || !n.externalId!.endsWith(`@${studentDomain}`))
    .map((n) => ({
      note: n.name,
      name: displayName(n.body, n.name),
      surname: n.name.split('-').at(-1) ?? '',
    }))
    .filter((p) => p.surname !== '');
}

/** What the caller knows that the vault does not. */
export interface AskContext {
  studentDomain?: string;
  /** Today, told rather than looked up, because a model has no clock. */
  today?: string;
}

/**
 * What a thing on Google Classroom actually is.
 *
 * Everything arrives as a "course", which is Google's word rather than the
 * school's. Underneath sit taught subjects, clubs, houses, form groups, exam
 * cohorts and the group somebody made to send out bus times, and the
 * difference decides whether asking who teaches it makes any sense and whether
 * it belongs among a student's subjects or among the things they do.
 *
 * The answers are offered as a closed set, which is not the fixed vocabulary
 * this file argues against elsewhere. That argument is about relation types,
 * where the space is open and any list omits the case that matters. This is
 * one question whose answers really are few, and where none of them fits, the
 * answer is nothing at all.
 */
export async function askWhatKindOfThing(
  vault: Vault,
  course: string,
  _context: AskContext,
): Promise<Question | null> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  const note = entities.find((n) => n.name === course);
  if (!note) return null;

  const about = episodes.filter((e) => e.body.includes(`[[${course}]]`));
  const work = entities.filter(
    (n) => n.description === 'Assignment' && n.body.includes(`[[${course}]]`),
  );
  if (about.length === 0 && work.length === 0) return null;

  const tells = howTelling(episodes.map((e) => e.body));

  /*
   * The name first, because the name is usually the best evidence there is,
   * and then enough of what happens inside to catch it when it lies.
   */
  const evidence: Evidence[] = [
    {
      note: note.name,
      quote: `The group is called "${note.name}". ${note.body}`.slice(0, QUOTE_LIMIT),
    },
    ...work.slice(0, 3).map((w) => ({
      note: w.name,
      quote: `Work set in it: ${w.body.split('\n')[0] ?? w.name}`.slice(0, QUOTE_LIMIT),
    })),
    /*
     * Spread across the life of the course rather than taken off the end.
     *
     * What kind of thing something is is a question about the whole of it, and
     * in June every course in the school is doing exams and notices. A bundle
     * drawn from the most recent fortnight describes the term, not the thing.
     */
    /*
     * What is peculiar to this course, spread across its life.
     *
     * Bus times, photo days and locker reminders go to every class in the
     * school and say nothing whatever about which class they went to -- and
     * there are far more of them than there are notes about what the class
     * actually does. Sampling evenly gives boilerplate a share of the bundle
     * proportional to how much of it there is, which is exactly backwards.
     */
    ...mostTelling(about, (note) => tells(note.body), EVIDENCE_LIMIT - 4)
      // Chosen for what they say, then put back in order so the bundle reads
      // as the life of a course rather than a ranking.
      .sort((a, b) => (a.occurred ?? '').localeCompare(b.occurred ?? ''))
      .map((e) => ({ note: e.name, quote: plain(e.body).slice(0, QUOTE_LIMIT) })),
  ];

  return {
    subject: course,
    relation: 'is',
    asking: `What kind of thing is ${course} at this school?`,
    candidates: [
      'a taught subject',
      'a club or activity',
      'a house or form group',
      'an administrative or information group',
    ],
    guarantees: [
      'Everything at this school arrives as a "course" on Google Classroom, which is',
      "the software's word and not the school's. Subjects, clubs, houses, form groups",
      'and noticeboards all look identical from the outside.',
      '',
      /*
       * What the offered answers mean.
       *
       * A closed list with no definitions makes a reader invent the boundaries
       * and then object that the one it wants is missing. Left undefined, this
       * list drew exactly that: a refusal to choose between two options on the
       * grounds that either could have received the same notices.
       */
      'What the answers mean here:',
      '- a taught subject: lessons happen, work is set and marked, it appears on a',
      '  timetable and a report.',
      '- a club or activity: people choose to be in it, it meets outside lessons, and',
      '  what it sets is preparation for doing the thing rather than assessed work.',
      '- a house or form group: people belong to it rather than attend it, and it is',
      '  about competitions, points, assemblies, pastoral care and belonging.',
      '- an administrative or information group: it exists to send notices to people',
      '  who share a year or a bus or a building. Nothing is taught or organised in it.',
      '',
      'The name is evidence and is not proof. This school has a house called French',
      'and a subject called French, and they have nothing to do with each other, so a',
      'name that matches a subject settles nothing on its own.',
      '',
      'Answer null if it is none of these, or if what happens inside would fit two of',
      'them equally.',
    ],
    evidence,
  };
}

/**
 * Whether a course is happening now, finished, or still to come.
 *
 * A document written in late August had a student "preparing for the history
 * exam and completing an IB MYP Personal Project" -- one finished the previous
 * November, the other in February. Every note in both was dated. Nothing in
 * the pass that wrote it had any idea what day it was.
 *
 * Deliberately a judgement rather than arithmetic. A course silent since June
 * is over if today is October and merely on holiday if today is July, and no
 * threshold in days is right on both sides of a summer. What is arithmetic --
 * the first date, the last date, the last deadline -- is worked out here and
 * handed over as fact.
 */
export async function askWhetherItIsRunning(
  vault: Vault,
  course: string,
  { today }: AskContext,
): Promise<Question | null> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  const dated = episodes
    .filter((e) => e.occurred && e.body.includes(`[[${course}]]`))
    .sort((a, b) => (a.occurred as string).localeCompare(b.occurred as string));

  // Nothing dated is nothing to reason from, and any answer would be a guess.
  if (dated.length === 0) return null;

  const first = dated[0] as VaultNote;
  const last = dated.at(-1) as VaultNote;

  const deadlines = entities
    .filter((n) => n.description === 'Assignment' && n.body.includes(`[[${course}]]`))
    .map((n) => /^Due: (\S+)/m.exec(n.body)?.[1])
    .filter((at): at is string => Boolean(at))
    .sort();

  const day = (note: VaultNote) => (note.occurred as string).slice(0, 10);
  const evidence: Evidence[] = [
    { note: first.name, quote: `${day(first)}: ${plain(first.body)}`.slice(0, QUOTE_LIMIT) },
    { note: last.name, quote: `${day(last)}: ${plain(last.body)}`.slice(0, QUOTE_LIMIT) },
  ];
  if (deadlines.length > 0) {
    evidence.push({
      note: course,
      quote:
        `Work was set in this course with deadlines from ${(deadlines[0] as string).slice(0, 10)} ` +
        `to ${(deadlines.at(-1) as string).slice(0, 10)}.`,
    });
  }

  /*
   * When the rest of the school was last doing anything.
   *
   * Silence means nothing on its own. A course that stopped in November is
   * finished if every other course ran on until June, and merely between terms
   * if they all stopped in November too. Without the comparison a reader is
   * right to refuse, and did: shown one quiet course it cannot tell whether
   * the course ended or the school did.
   */
  const elsewhere = episodes
    .filter((e) => e.occurred && !e.body.includes(`[[${course}]]`))
    .map((e) => e.occurred as string)
    .sort();

  return {
    subject: course,
    relation: 'is currently',
    asking: `Is ${course} running at the moment?`,
    candidates: ['running', 'finished', 'not yet started'],
    guarantees: [
      `Today is ${today ?? 'not known'}.`,
      '',
      ...(elsewhere.length > 0
        ? [
            `Everywhere else in these records, the most recent activity is ` +
              `${(elsewhere.at(-1) as string).slice(0, 10)} and the earliest is ` +
              `${(elsewhere[0] as string).slice(0, 10)}. Use that to tell a course that`,
            'stopped from a school that stopped: silence during a period when everything',
            'else was quiet is a holiday, and silence while everything else carried on is',
            'a course that ended.',
            '',
          ]
        : []),
      'What the answers mean here:',
      '- running: the student is in it this year, whether or not anything is happening',
      '  this week. A course in the middle of a holiday is still running.',
      '- finished: it is over. The year it belonged to has ended and it will not',
      '  resume. A course that stopped and whose school year has since ended is',
      '  finished, not on holiday.',
      '- not yet started: it exists but belongs to a year that has not begun.',
      '',
      `There are ${dated.length} dated notes in this course. The earliest and the latest`,
      'are quoted below; nothing happened in it before the first or after the last.',
      '',
      'Think about where today falls in a school year rather than counting days. A',
      'course silent since June is finished if today is October and on holiday if today',
      'is July. A course whose only dates are months ahead has not started.',
      '',
      'Answer null if the dates genuinely do not say.',
    ],
    evidence,
  };
}

/** Wikilinks and whitespace taken out, so a quote reads as a sentence. */
const plain = (body: string) =>
  body
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** Every member of staff the vault knows, with the name a person would use. */
export async function staffRoster(
  vault: Vault,
  studentDomain?: string,
): Promise<{ note: string; name: string }[]> {
  return staffIn(await vault.list('entity'), studentDomain).map(({ note, name }) => ({
    note,
    name,
  }));
}

export async function askWhoTeaches(
  vault: Vault,
  course: string,
  { studentDomain }: AskContext,
): Promise<(Question & { omitted: number }) | null> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  const staff = staffIn(entities, studentDomain);
  if (staff.length === 0) return null;

  const about = episodes.filter((e) => e.body.includes(`[[${course}]]`));

  /*
   * Only notes that put a member of staff near this course carry anything. A
   * note about the course naming nobody is not evidence about who teaches it,
   * and including it makes the ones that are harder to see.
   */
  const found: Ranked[] = [];
  for (const note of about) {
    const named = staff.filter(
      (p) =>
        mentions(note.body, p.surname) || (note.actor ? mentions(note.actor, p.surname) : false),
    );
    if (named.length === 0) continue;
    /*
     * Whether the writer is themselves one of the candidates.
     *
     * It decides what counts as relevant below, and it is the difference
     * between reading a signature and reading an account of what somebody did.
     */
    const bySelf = note.actor
      ? staff.some((p) => mentions(note.actor as string, p.surname))
      : false;

    /*
     * Dated, because who holds a role changes.
     *
     * A course that changed hands is unreadable without them: "this is my last
     * week, Ms Adeyemi will take over" and "I am taking this class from now
     * on" say opposite things about who teaches it today, and which is current
     * depends entirely on when each was written. Shown both undated, a reader
     * concluded the handover was still ahead and named the departing teacher.
     */
    const quote = quoteFor(
      note.body,
      named.map((p) => p.surname),
      bySelf,
      note.actor,
      note.occurred?.slice(0, 10),
    );

    /*
     * How directly this note bears on the question.
     *
     * Somebody writing "I marked your essays" is telling you what they do with
     * this class. Somebody being named in a notice is telling you they exist.
     * Both used to be cut in whatever order the filesystem listed them, under
     * a comment claiming they were newest first -- which is invisible at four
     * notes and fatal at thirty, because the one note that answers the
     * question falls off the end and the pass declines for want of evidence it
     * was holding.
     */
    found.push({
      evidence: { note: note.name, quote },
      rank: bySelf ? (FIRST_PERSON.test(quote) ? 2 : 1) : 0,
      when: note.occurred ?? '',
    });
  }

  if (found.length === 0) return null;

  // Direct accounts first, then newest: where a course changed hands, the
  // recent half is the half that is still true.
  const ordered = byRank(found);

  /*
   * Only people the reader can actually see evidence about.
   *
   * A candidate whose note did not survive the cut is a name with nothing
   * behind it, and the closed set is meant to be the answers this evidence
   * could support -- not everybody who has ever been near the course.
   */
  const candidates = [
    ...new Set(
      staff.filter((p) => ordered.some((e) => mentions(e.quote, p.surname))).map((p) => p.name),
    ),
  ];
  if (candidates.length === 0) return null;

  return {
    subject: course,
    relation: 'taught by',
    asking: `Who teaches ${course}?`,
    candidates,
    /*
     * What this narrowing knows and the bundle cannot show. Stated by the code
     * that guaranteed it, rather than by the module that asks the question --
     * only this function knows it collected notes linked to one course and
     * excluded every student before anybody was asked.
     */
    guarantees: [
      `Every quote below was taken from a note attached to ${course} in the school`,
      'records. That attachment is recorded, not inferred, so a quote that does not',
      `name ${course} is still about it. Do not treat the absence of the course name`,
      'in a quote as evidence of anything.',
      '',
      'Every candidate is a member of staff, identified by a staff address in those',
      'records. Students are excluded before this question is asked and cannot appear',
      'below, so no quote here is a pupil writing to their teacher.',
      '',
      'A quote reads "date, Name wrote: ..." -- when the note was sent and who sent it.',
      'Anything after that is their own words, including how they sign themselves.',
      'Where the quotes disagree about who holds a role, the later one is current.',
    ],
    evidence: ordered,
    /** Never trimmed silently: a cut bundle reads downstream as the whole story. */
    omitted: Math.max(0, found.length - ordered.length),
  };
}

/**
 * What somebody is, from the one place anybody ever writes it down.
 *
 * People state their role in an appositive after their name -- "Mr George,
 * Head of Grade 10" -- once, in whichever class they happened to be writing to
 * that morning, and then never again. That is a convention of institutional
 * mail rather than anything about this school, and it is the only place a role
 * appears at all.
 *
 * Asked per person and across every course, because the sentence that settles
 * what somebody is almost never sits in the course where it matters. A pass
 * looking at one class sees a head of year setting deadlines, a librarian
 * chasing books, a colleague covering a lesson and a trainee taking some of
 * them, and concludes that all four teach it. On the evidence in front of it,
 * that is a reasonable conclusion, which is why the fix is more evidence
 * rather than more caution.
 *
 * The candidates are spans copied out of the notes, never a list of roles this
 * code thought of in advance. A fixed vocabulary would have had no entry for a
 * house, a form tutor or a placement student, and would have pushed all three
 * into whichever of its words fitted worst.
 */
export async function askWhatTheyDo(
  vault: Vault,
  person: string,
  { studentDomain }: AskContext,
): Promise<Question | null> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  const who = staffIn(entities, studentDomain).find((p) => p.note === person);
  if (!who) return null;

  const about = episodes.filter(
    (e) => mentions(e.body, who.surname) || (e.actor ? mentions(e.actor, who.surname) : false),
  );
  if (about.length === 0) return null;

  const candidates = new Set<string>();
  const found: Ranked[] = [];
  for (const note of about) {
    const prose = plain(note.body);
    const spans = describedAs(prose, who.surname);
    for (const span of spans) candidates.add(span);
    // The appositive appears once in a term. Everything else is traffic, and
    // a cap taken off the end of a directory listing throws away the only
    // sentence that answers the question.
    found.push({
      evidence: { note: note.name, quote: prose.slice(0, QUOTE_LIMIT) },
      rank: spans.length > 0 ? 1 : 0,
      when: note.occurred ?? '',
    });
  }

  // Nobody ever said, which is the ordinary case. No candidates, no question.
  if (candidates.size === 0) return null;

  return {
    subject: person,
    relation: 'works at the school as',
    asking: `What is ${who.name}'s role at the school?`,
    candidates: [...candidates],
    guarantees: [
      `Every quote below is a note mentioning ${who.name}, from anywhere in the`,
      'records rather than from one class. They are a member of staff: students are',
      'excluded before this question is asked.',
      '',
      'The candidates are phrases copied out of those quotes, where somebody wrote a',
      `description immediately after ${who.name}'s name. Choose the one that says what`,
      'they do at the school. Choose null if none of them is a description of a person',
      '-- an instruction addressed to them, or a fragment, is not a role.',
    ],
    evidence: byRank(found),
  };
}

/**
 * Phrases somebody was described by, immediately after their name.
 *
 * Only an appositive: a comma straight after the name, then a phrase, then a
 * full stop. Anything looser matches "Mr George, please bring the register",
 * which is an instruction addressed to a person rather than a statement about
 * one, and would have made "please bring the register" a role.
 */
function describedAs(prose: string, surname: string): string[] {
  const pattern = new RegExp(String.raw`\b${escape(surname)}\b\s*,\s*([^.;!?]{3,100})`, 'gi');
  return [...prose.matchAll(pattern)]
    .map((m) => shorten((m[1] as string).trim()))
    .filter((span) => span.length >= 3 && !IMPERATIVE.test(span));
}

/**
 * Something asked of a person, rather than something said about one.
 *
 * A role is a noun phrase. What follows a name and a comma otherwise is nearly
 * always a request -- "please bring", "could you", "let me know" -- and the
 * giveaway is that it opens with a verb or an address rather than a thing.
 */
/**
 * An appositive cut back to the role it opens with.
 *
 * Taken whole, "who is on teaching placement with us this term and will be
 * taking some of your lessons" becomes the object of a claim, and that claim
 * then goes into every prompt that mentions her. A role is the first clause;
 * everything after the conjunction is what the role entails, which belongs in
 * the evidence rather than in the name of the thing.
 *
 * Still a contiguous run of somebody's own words, so nothing is invented by
 * shortening -- only by keeping less.
 */
function shorten(span: string): string {
  return span
    .replace(/^who\s+(?:is|was|has been)\s+/i, '')
    .split(/\s+(?:and|but|who|which|while)\s+/i)[0]
    ?.trim()
    .replace(/[,;:]$/, '') as string;
}

const IMPERATIVE =
  /^(?:please\b|can\b|could\b|would\b|will\b|do\b|don't\b|let\b|see\b|bring\b|send\b|check\b|note\b|remember\b|thanks\b|thank\b|I\b|we\b|you\b|your\b|the\b|this\b|that\b|it\b|there\b|here\b|and\b|but\b|or\b|as\b|if\b|when\b|for\b)/i;

/** A piece of evidence with what it is worth and when it happened. */
interface Ranked {
  evidence: Evidence;
  rank: number;
  when: string;
}

/**
 * The most telling evidence, and no more than that.
 *
 * Rank before recency, because a note that answers the question is worth more
 * than a newer note that does not, and the cap has to fall on the notes that
 * were never going to help.
 *
 * The cap is a ceiling and not a quota, which is the part that took a hundred
 * and twenty notes of ordinary school traffic to notice. Two notes where
 * somebody says what they did with a class answer the question completely;
 * topping them up to twelve with notes that merely mention people adds
 * nothing and makes the two harder to read. The cover-teacher case began
 * failing consistently at that volume with the sentence that refutes it
 * present in the bundle every single time.
 *
 * So everything of the best rank goes in, and lesser evidence only tops it up
 * to a floor -- enough for a reader to see what else was around, never enough
 * to bury what matters.
 */
const ENOUGH = 4;

function byRank(found: readonly Ranked[]): Evidence[] {
  const ranked = [...found].sort((a, b) => b.rank - a.rank || b.when.localeCompare(a.when));
  const best = ranked[0]?.rank ?? 0;
  const strongest = ranked.filter((f) => f.rank === best);
  const kept =
    strongest.length >= ENOUGH
      ? strongest
      : [
          ...strongest,
          ...ranked.filter((f) => f.rank !== best).slice(0, ENOUGH - strongest.length),
        ];
  return kept.slice(0, EVIDENCE_LIMIT).map((f) => f.evidence);
}

/**
 * How much a note says about the thing it belongs to.
 *
 * Words that turn up everywhere carry no information about where they turned
 * up. A notice about the bus is sent to every class in the school, so the
 * words in it are common across the vault and the note scores low; a note
 * about house points and galas uses words almost nothing else does and scores
 * high.
 *
 * Rarity across the vault rather than a list of boring words, because the
 * boring words differ by school and any list would be written for this one.
 * Averaged over the distinct words in a note so that length is not mistaken
 * for substance.
 */
function howTelling(bodies: readonly string[]): (body: string) => number {
  const seen = new Map<string, number>();
  for (const body of bodies) {
    for (const word of new Set(words(body))) seen.set(word, (seen.get(word) ?? 0) + 1);
  }
  const total = Math.max(1, bodies.length);

  return (body: string) => {
    const distinct = [...new Set(words(body))];
    if (distinct.length === 0) return 0;
    const score = distinct.reduce(
      (sum, word) => sum + Math.log(total / (1 + (seen.get(word) ?? 0))),
      0,
    );
    return score / distinct.length;
  };
}

/**
 * The notes that actually say something, and no more than those.
 *
 * The same rule as byRank, for a score that is continuous rather than a small
 * integer: everything close to the best goes in, and the rest only tops it up
 * to a floor. Filling the remaining space with boilerplate does not add
 * context, it changes the answer -- a bundle mostly made of bus times reads as
 * an administrative group whatever else is in it, which is how a house came
 * back as a noticeboard under a hundred and twenty notices.
 */
function mostTelling<T>(notes: readonly T[], score: (note: T) => number, cap: number): T[] {
  const ranked = [...notes].sort((a, b) => score(b) - score(a));
  const best = ranked[0] ? score(ranked[0]) : 0;
  const strong = ranked.filter((n) => score(n) >= best * NEARLY_AS_GOOD);
  const kept = strong.length >= ENOUGH ? strong : ranked.slice(0, ENOUGH);
  return kept.slice(0, cap);
}

/** How close to the best a note must score to count as telling too. */
const NEARLY_AS_GOOD = 0.7;

const words = (body: string) =>
  plain(body)
    .toLowerCase()
    .replace(/[^a-zà-ÿ\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

/** Whether a surname appears as a word, rather than inside another one. */
function mentions(text: string, surname: string): boolean {
  if (surname === '') return false;
  return new RegExp(`\\b${escape(surname)}\\b`, 'i').test(text);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The part of a note that bears on who somebody is, not the whole note.
 *
 * A classroom announcement is mostly bus times and permission slips, and the
 * one clause saying what somebody does with the class is the evidence. Cutting
 * to the sentences a name appears in gets most of the way there and was, on
 * its own, badly wrong: a teacher writing "Mr George. The unit test is
 * Tuesday. I have posted the review problems and I will go over them in class
 * Monday" has their name in the signature and their teaching everywhere else.
 * The bundle handed over was "Mr George." and the pass declined to name a
 * teacher on the strength of a signature, which was the right call on the
 * evidence it was given.
 *
 * So when the writer is themselves a candidate, what they say they personally
 * did counts too. Narrowing is meant to remove distraction, not evidence.
 */
function quoteFor(
  body: string,
  surnames: readonly string[],
  bySelf: boolean,
  actor?: string,
  on?: string,
): string {
  const prose = body.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ');
  const sentences = prose.split(/(?<=[.!?])\s+/);
  const relevant = sentences.filter(
    (s) => surnames.some((surname) => mentions(s, surname)) || (bySelf && FIRST_PERSON.test(s)),
  );
  const quote = (relevant.length > 0 ? relevant : sentences).join(' ').trim();
  const prefix = `${on ? `${on}, ` : ''}${actor ? `${actor} wrote: ` : ''}`;
  return (prefix + quote).slice(0, QUOTE_LIMIT);
}

/** "I have posted", "my lesson" -- somebody describing their own part in it. */
const FIRST_PERSON = /\bI\b|\b[Mm]y\b/;

/** The name as a person writes it, from the note's first line. */
function displayName(body: string, slug: string): string {
  const first = body.split('\n')[0] ?? '';
  const before = first.split(',')[0]?.trim();
  if (before && /^[A-ZÀ-Ü]/.test(before)) return before;
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
