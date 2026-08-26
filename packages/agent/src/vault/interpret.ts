import type { LlmProvider } from '@contexto/llm';
import { INTERPRETING, REFUTING } from '../prompts/documents.js';
import type { Claim, Evidence } from './claims.js';

/**
 * One question, one small bundle of evidence, one claim or none.
 *
 * Two model calls with rules between and after them, replacing the single
 * forward pass that produced every wrong answer this vault has given. The
 * first proposes and is told, in the prompt, that declining scores as well as
 * being right -- the cheapest intervention in the literature and the one this
 * system had never tried, having only ever asked for a teacher and been given
 * one. The second is shown the proposal and asked to break it, which is a
 * different question and fails in a different direction than the first.
 *
 * Neither is trusted about what it read. The answer must be one the caller
 * offered and the citations must resolve to notes actually shown, both checked
 * here, because a model that invented a name will justify it eloquently and a
 * fabricated citation survives every check that reads it rather than resolving
 * it.
 *
 * The evidence bundle is small by construction, and that is not only about
 * cost. Accuracy on a fact sitting in the middle of a long context falls off
 * hard, and semantically similar irrelevant material -- which is what a school
 * vault is made of -- is the worst kind of filler. Whoever calls this narrows
 * first, deterministically, and asks about one thing at a time.
 */

export interface Question {
  /** The note being asked about. */
  subject: string;
  /** What the answer would be to the subject, in open words. */
  relation: string;
  /** The question itself, as a person would put it. */
  asking: string;
  /**
   * Every answer that could possibly be correct.
   *
   * A closed set the caller worked out without a model. An answer outside it
   * was not read from anything, and this is where the invented teacher and
   * the house-mistaken-for-a-subject both die.
   */
  candidates: readonly string[];
  /** Bounded, pre-narrowed, and the only thing either pass gets to see. */
  evidence: readonly Evidence[];
}

export interface InterpretDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface InterpretContext {
  userId: string;
}

interface Proposal {
  answer: string | null;
  confidence?: number;
  evidence?: string[];
  alternatives?: string[];
}

export async function interpret(
  { llm }: InterpretDeps,
  question: Question,
  { userId }: InterpretContext,
): Promise<Claim | null> {
  if (question.candidates.length === 0 || question.evidence.length === 0) return null;

  const bundle = question.evidence.map((e) => `- ${e.note}: ${e.quote}`).join('\n');

  /*
   * The one guarantee the narrowing makes, said out loud.
   *
   * Every quote here was taken from a note the school's records attach to this
   * subject; nothing else was collected. Leaving that implicit cost nearly
   * every true claim in the corpus, because a quote reading "your practical
   * assessment is due Friday" does not name the course, and a reader with no
   * reason to believe otherwise is right to say so. The system knew and did
   * not pass it on, which is the same failure as the rest of this file in
   * miniature: an observation held somewhere no reader could see it.
   */
  const provenance = [
    `Every quote below was taken from a note attached to ${question.subject} in the`,
    'school records. That attachment is recorded, not inferred, so a quote that',
    `does not name ${question.subject} is still about it. Do not treat the absence`,
    'of the course name in a quote as evidence of anything.',
    '',
    /*
     * The second guarantee the narrowing makes, and the second one that cost a
     * true claim by going unsaid. A refuter knocked down a correct teacher on
     * the grounds that the message "could describe a student writing to the
     * teacher" -- students are excluded from this list before anybody is
     * asked, by mail domain, and cannot appear in it.
     */
    'Every candidate is a member of staff, identified by a staff address in those',
    'records. Students are excluded before this question is asked and cannot',
    'appear below, so no quote here is a pupil writing to their teacher.',
    '',
    'A quote reads "Name wrote: ..." where Name is who sent the note. Anything',
    'after that is their own words, including how they sign themselves.',
  ].join('\n');

  const brief = [
    `Question: ${question.asking}`,
    `It is about: ${question.subject}`,
    '',
    provenance,
    '',
    'The answer must be one of these, or null:',
    ...question.candidates.map((c) => `- ${c}`),
    '',
    'The evidence, in full:',
    bundle,
  ].join('\n');

  const proposed = parse<Proposal>(
    (await llm.chat({ messages: [system(INTERPRETING.body), user(brief)] }, { userId })).content,
  );

  // An unreadable proposal is an abstention. Salvaging a name out of prose the
  // model failed to format is guessing at a guess.
  if (!proposed || typeof proposed.answer !== 'string' || proposed.answer.trim() === '')
    return null;

  const answer = question.candidates.find((c) => same(c, proposed.answer as string));
  if (!answer) return null;

  /*
   * Citations are resolved, not read. A note name that does not appear in the
   * bundle was written rather than found, and a claim whose provenance is
   * invented is more dangerous than one with none -- it passes inspection.
   */
  const cited = (proposed.evidence ?? [])
    .map((name) => question.evidence.find((e) => same(e.note, name)))
    .filter((e): e is Evidence => Boolean(e));
  if (cited.length === 0 || cited.length !== (proposed.evidence ?? []).length) return null;

  const confidence = Math.min(1, Math.max(0, Number(proposed.confidence ?? 0)));
  const alternatives = (proposed.alternatives ?? []).filter((a) =>
    question.candidates.some((c) => same(c, a)),
  );

  const challenge = [
    `The claim: ${question.subject} — ${question.relation} — ${answer}`,
    `Proposed with confidence ${confidence.toFixed(2)}.`,
    alternatives.length > 0 ? `They ruled out: ${alternatives.join(', ')}.` : '',
    '',
    provenance,
    '',
    'The evidence they were given, in full:',
    bundle,
    '',
    'The other answers that were available to them:',
    ...question.candidates.filter((c) => c !== answer).map((c) => `- ${c}`),
    '',
    /*
     * Who the names belong to, because the refuter was refusing over it.
     *
     * It knocked down a correct claim on the grounds that a quote saying "Ms
     * Adeyemi will take over the class" never established that this was Tolu
     * Adeyemi. Every candidate is a person the school's own records already
     * resolved to an address, and there is only one of each surname in the
     * list -- so that objection is always available and never worth anything.
     * Refusing on it is refusing on the format of the evidence rather than on
     * what the evidence says.
     */
    'Each candidate is a person already identified in the school records, by',
    'their address. A surname in a quote matching exactly one candidate is that',
    'candidate: do not refute on the grounds that only the surname appears.',
  ]
    .filter(Boolean)
    .join('\n');

  const verdict = parse<{ refuted?: boolean }>(
    (await llm.chat({ messages: [system(REFUTING.body), user(challenge)] }, { userId })).content,
  );

  // A refuter that cannot be read has not cleared the claim. Silence from the
  // one step whose job is doubt is not consent.
  if (!verdict || verdict.refuted !== false) return null;

  return {
    subject: question.subject,
    relation: question.relation,
    object: answer,
    basis: 'inferred',
    evidence: cited,
    confidence,
    alternatives,
  };
}

const system = (content: string) => ({ role: 'system' as const, content });
const user = (content: string) => ({ role: 'user' as const, content });

/** Names differing only in case or surrounding space are the same name. */
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * JSON from a reply that may be wearing a code fence.
 *
 * Null on anything unreadable, and every caller treats null as an abstention,
 * so a parse failure can only ever lose a claim rather than admit a bad one.
 */
function parse<T>(content: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const text = (fenced?.[1] ?? content).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
