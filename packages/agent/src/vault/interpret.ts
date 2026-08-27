import type { LlmProvider } from '@contexto/llm';
import { INTERPRETING, REFUTING } from '../prompts/documents.js';
import { retrying } from './retry.js';
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
  /**
   * What the narrowing knows about this bundle that the bundle cannot show.
   *
   * These belong to whoever did the narrowing, because only that code knows
   * what it guaranteed. They were once written here, phrased for courses and
   * teachers, which made a module meant to answer any question able to answer
   * only one honestly.
   *
   * Saying them is not a nicety. Leaving them unsaid cost nearly every true
   * claim in the corpus: a reader shown "your practical assessment is due
   * Friday" objected that it never says chemistry, and was right on what it
   * could see. The system knew the note was attached to chemistry and did not
   * pass it on -- an observation held somewhere no reader could reach, which
   * is this whole file's disease in miniature.
   *
   * That has now been the cause three separate times: the course a note is
   * attached to, that students were excluded before anybody was asked, and
   * that the records are the student's own so a class in them is a class they
   * are in. Each looked like a reader being obtuse and was a fact the system
   * held and would not share. When a refutation reads as pedantry, check what
   * the narrowing knows before rewriting the prompt: three times out of three
   * the reader was right.
   */
  guarantees?: readonly string[];
  /**
   * Claims already settled that bear on this question.
   *
   * Decided once, from all the evidence about their own subject, and reused
   * rather than re-derived here from whatever fragment happens to be in this
   * bundle. A person's role is the case that matters: the sentence saying
   * somebody is on teaching placement usually sits in a note about a
   * different course entirely, so a pass looking only at this one cannot
   * possibly find it and will confidently conclude they teach.
   */
  known?: readonly string[];
  /**
   * Whether this question can have more than one true answer.
   *
   * Asked to break "Ken Nakamura teaches science", a refuter answered that
   * Anna Bell teaches part of it too, so the evidence does not uniquely
   * support Ken. That is sound, and against a question admitting two answers
   * it refuses the second one every time -- the rules it was given were
   * written when the relation held one. A co-holder is not a rival, and the
   * only way a reader can know which it is looking at is to be told.
   */
  several?: boolean;
}

export interface InterpretDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface InterpretContext {
  userId: string;
}

/**
 * How many independent attempts to break a claim it has to survive.
 *
 * Two, not because two is principled but because it was measured: one caught
 * two thirds of the cover-teacher cases, and the cases it missed were not the
 * hard ones -- they were the same case on a different day.
 */
const REFUTERS = 2;

interface Proposal {
  /**
   * One answer, several, or none.
   *
   * Several because co-teaching is ordinary and a shape that cannot hold it
   * turns the commonest arrangement in a school into silence: French 10 has
   * two teachers, both posting its work and marking it, and the vault said
   * nothing about who taught it because two people doing the job read as a
   * contest and a contest withholds.
   */
  answer: string | string[] | null;
  confidence?: number;
  evidence?: string[];
  alternatives?: string[];
  qualifier?: string;
}

export async function interpret(
  { llm }: InterpretDeps,
  question: Question,
  { userId }: InterpretContext,
): Promise<Claim[]> {
  if (question.candidates.length === 0 || question.evidence.length === 0) return [];

  const bundle = question.evidence.map((e) => `- ${e.note}: ${e.quote}`).join('\n');

  const guarantees = question.guarantees ?? [];
  const known = question.known ?? [];

  /** Stated as fact, because each one survived this same process. */
  const settled =
    known.length > 0
      ? ['Already established, and not up for reconsideration here:', ...known.map((k) => `- ${k}`)]
      : [];

  const brief = [
    `Question: ${question.asking}`,
    `It is about: ${question.subject}`,
    '',
    ...guarantees,
    ...(guarantees.length > 0 ? [''] : []),
    ...settled,
    ...(settled.length > 0 ? [''] : []),
    'The answer must be one of these, or null:',
    ...question.candidates.map((c) => `- ${c}`),
    '',
    'The evidence, in full:',
    bundle,
  ].join('\n');

  /*
   * Retried, because a vault build makes hundreds of these.
   *
   * Without it a rate limit is indistinguishable from an abstention: the call
   * throws, the caller treats a missing claim as nothing worth saying, and the
   * vault quietly knows less than it did. That is exactly the silent loss this
   * whole design is built to refuse, and it was in the pass itself. It showed
   * up first in the eval, where two dozen swallowed 429s read as the pass
   * having become cautious.
   */
  const proposed = parse<Proposal>(
    (
      await retrying(() =>
        llm.chat({ messages: [system(INTERPRETING.body), user(brief)] }, { userId }),
      )
    ).content,
  );

  // An unreadable proposal is an abstention. Salvaging a name out of prose the
  // model failed to format is guessing at a guess.
  if (!proposed) return [];

  const offered = (Array.isArray(proposed.answer) ? proposed.answer : [proposed.answer])
    .filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    .map((a) => question.candidates.find((c) => same(c, a)))
    .filter((a): a is string => Boolean(a));

  // Every answer must be one the caller offered, and duplicates are one answer.
  const answers = [...new Set(offered)];
  if (answers.length === 0) return [];

  /*
   * Citations are resolved, not read. A note name that does not appear in the
   * bundle was written rather than found, and a claim whose provenance is
   * invented is more dangerous than one with none -- it passes inspection.
   */
  const cited = (proposed.evidence ?? [])
    .map((name) => question.evidence.find((e) => same(e.note, name)))
    .filter((e): e is Evidence => Boolean(e));
  if (cited.length === 0 || cited.length !== (proposed.evidence ?? []).length) return [];

  const confidence = Math.min(1, Math.max(0, Number(proposed.confidence ?? 0)));
  const alternatives = (proposed.alternatives ?? []).filter((a) =>
    question.candidates.some((c) => same(c, a)),
  );

  /*
   * Each answer is challenged on its own.
   *
   * Two people teaching one class are two claims, and a refuter shown both at
   * once will reach for the one that fits worse and refuse the pair. What has
   * to be asked of each is whether the evidence supports that person, not
   * whether the set is tidy.
   */
  const survivors: Claim[] = [];
  for (const answer of answers) {
    const challenge = [
      `The claim: ${question.subject} — ${question.relation} — ${answer}`,
      `Proposed with confidence ${confidence.toFixed(2)}.`,
      alternatives.length > 0 ? `They ruled out: ${alternatives.join(', ')}.` : '',
      '',
      ...guarantees,
      ...(guarantees.length > 0 ? [''] : []),
      ...settled,
      ...(settled.length > 0 ? [''] : []),
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
      ...(question.several
        ? [
            'This question can have more than one true answer, and more than one was',
            'proposed. Another candidate also holding the relation is not a reason to',
            'refuse this one: refuse only if the evidence fails to support the person',
            'named here. "It does not uniquely support them" is not a refutation of a',
            'question that was never asking for a unique answer.',
            '',
          ]
        : []),
      'Each candidate is a person already identified in the school records, by',
      'their address. A surname in a quote matching exactly one candidate is that',
      'candidate: do not refute on the grounds that only the surname appears.',
    ]
      .filter(Boolean)
      .join('\n');

    /*
     * Asked more than once, because one refuter is one sample.
     *
     * The judgement is not deterministic, and treating a single sample as a
     * verdict is the mistake this whole file exists to stop -- one reading,
     * promoted to settled. Measured under a hundred and twenty ordinary notices,
     * a lone refuter caught the cover-teacher case about two times in three, and
     * the other third shipped a wrong teacher.
     *
     * Disagreement between them is contention, and contention withholds. That is
     * the same rule settling uses between rival readings of a slot, applied to
     * rival readings of one claim. It costs a little recall and buys back the
     * kind of error that is read aloud before every conversation a student has,
     * which is the trade this system makes everywhere else too.
     */
    const verdicts = await Promise.all(
      Array.from({ length: REFUTERS }, () =>
        retrying(() =>
          llm.chat({ messages: [system(REFUTING.body), user(challenge)] }, { userId }),
        ).then((reply) => parse<{ refuted?: boolean }>(reply.content)),
      ),
    );

    // A refuter that cannot be read has not cleared the claim. Silence from the
    // step whose whole job is doubt is not consent.
    if (verdicts.some((verdict) => !verdict || verdict.refuted !== false)) continue;

    /*
     * A qualifier has to be in the evidence, word for word.
     *
     * Dropped rather than fatal, because the claim itself may be perfectly good
     * and a composed hedge is a smaller error than a composed answer. But it is
     * dropped: a limit nobody wrote is a limit that cannot be checked, and it
     * would be believed more readily than the claim it qualifies.
     */
    const quoted = proposed.qualifier?.trim();
    const qualifier =
      quoted && cited.some((e) => e.quote.toLowerCase().includes(quoted.toLowerCase()))
        ? quoted
        : undefined;

    survivors.push({
      subject: question.subject,
      relation: question.relation,
      object: answer,
      basis: 'inferred',
      evidence: cited,
      confidence,
      alternatives,
      ...(qualifier ? { qualifier } : {}),
    });
  }

  return survivors;
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
