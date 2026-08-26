import type { Question } from './interpret.js';
import type { Evidence } from './claims.js';
import type { Vault } from './vault.js';

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
export async function askWhoTeaches(
  vault: Vault,
  course: string,
  studentDomain?: string,
): Promise<(Question & { omitted: number }) | null> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  /*
   * Staff, by mail domain, and nothing else.
   *
   * This school puts students on one domain and staff on another, and that
   * single fact does more work than any amount of reasoning about who writes
   * the most mail. Without it a Grade 10 student who emailed only ever about
   * maths was named the maths teacher -- she looked devoted to one subject,
   * which is what struggling with one subject looks like.
   */
  const staff = entities
    .filter((n) => n.description === 'Person' && n.externalId)
    .filter((n) => !studentDomain || !n.externalId!.endsWith(`@${studentDomain}`))
    .map((n) => ({ name: displayName(n.body, n.name), surname: n.name.split('-').at(-1) ?? '' }))
    .filter((p) => p.surname !== '');

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
    evidence: ordered.slice(0, EVIDENCE_LIMIT),
    /** Never trimmed silently: a cut bundle reads downstream as the whole story. */
    omitted: Math.max(0, ordered.length - EVIDENCE_LIMIT),
  };
}

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
