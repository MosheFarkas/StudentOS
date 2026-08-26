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
  studentDomain?: string,
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
  const found: Evidence[] = [];
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

    found.push({
      note: note.name,
      quote: quoteFor(
        note.body,
        named.map((p) => p.surname),
        bySelf,
        note.actor,
      ),
    });
  }

  if (found.length === 0) return null;

  const candidates = [
    ...new Set(
      staff.filter((p) => found.some((e) => mentions(e.quote, p.surname))).map((p) => p.name),
    ),
  ];
  if (candidates.length === 0) return null;

  // Newest first: where a course changed hands, the recent half is the half
  // that is still true.
  const ordered = [...found].reverse();

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
      'A quote reads "Name wrote: ..." where Name is who sent the note. Anything after',
      'that is their own words, including how they sign themselves.',
    ],
    evidence: ordered.slice(0, EVIDENCE_LIMIT),
    /** Never trimmed silently: a cut bundle reads downstream as the whole story. */
    omitted: Math.max(0, ordered.length - EVIDENCE_LIMIT),
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
  studentDomain?: string,
): Promise<Question | null> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  const who = staffIn(entities, studentDomain).find((p) => p.note === person);
  if (!who) return null;

  const about = episodes.filter(
    (e) => mentions(e.body, who.surname) || (e.actor ? mentions(e.actor, who.surname) : false),
  );
  if (about.length === 0) return null;

  const candidates = new Set<string>();
  const found: Evidence[] = [];
  for (const note of about) {
    const prose = note.body.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ');
    for (const span of describedAs(prose, who.surname)) candidates.add(span);
    found.push({ note: note.name, quote: prose.slice(0, QUOTE_LIMIT) });
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
    evidence: found.slice(-EVIDENCE_LIMIT),
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
): string {
  const prose = body.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ');
  const sentences = prose.split(/(?<=[.!?])\s+/);
  const relevant = sentences.filter(
    (s) => surnames.some((surname) => mentions(s, surname)) || (bySelf && FIRST_PERSON.test(s)),
  );
  const quote = (relevant.length > 0 ? relevant : sentences).join(' ').trim();
  const prefix = actor ? `${actor} wrote: ` : '';
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
