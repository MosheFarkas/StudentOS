import type { LlmProvider } from '@contexto/llm';
import { settle, type Claim, type Settlement, type Withheld } from './claims.js';
import { INQUIRIES } from './inquiries.js';
import { interpret } from './interpret.js';
import { staffRoster } from './evidence.js';
import type { Vault } from './vault.js';

/**
 * The vault, understood once, in one place.
 *
 * Before this there were three readers of the same fragments -- the digest,
 * the pass that writes user.md, and the agent mid-turn -- each working out what
 * the notes meant from its own partial view, and none of them able to record
 * that it had been working anything out at all. That is the whole disease: the
 * vault stored observations and every reader silently promoted them to
 * conclusions. Three guesses do not average out. They compound.
 *
 * So meaning is decided here, and downstream reads settled claims rather than
 * re-deriving from co-occurrence.
 *
 * Questions run in a declared order and each sees what the ones before it
 * settled. That ordering carries most of the accuracy: deciding what somebody
 * IS before asking what they DID is the difference between a head of year and
 * a history teacher, and no amount of care inside the second question can
 * recover a fact that only the first one had the evidence to reach.
 *
 * One question at a time. The tempting design was a single pass that saw
 * everything at once, on the theory that the full picture produces the best
 * judgement; the evidence says the opposite, and hardest for exactly this
 * material -- thousands of notes concerning the same twenty people, which is
 * the kind of near-miss context that degrades a long-context read worst. Small
 * bundles, then reconcile the answers rather than the raw material.
 */

export interface UnderstandDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface UnderstandOptions {
  userId: string;
  /** The students' own mail domain, which is what tells them from staff. */
  studentDomain?: string;
  /** Told rather than looked up, because a model has no clock. */
  today?: string;
}

export async function understandVault(
  { llm }: UnderstandDeps,
  vault: Vault,
  { userId, studentDomain, today }: UnderstandOptions,
): Promise<Settlement> {
  const roster = await staffRoster(vault, studentDomain);

  /*
   * How a person is named when a claim about them is quoted to another pass.
   *
   * Claims are keyed by note, because that is what provenance needs; the
   * candidates a question offers are the names a person would use. Without
   * this map the two never meet and every established fact is silently
   * dropped on the floor.
   */
  const named = new Map(roster.map((p) => [p.note, p.name]));
  const noteOf = new Map(roster.map((p) => [p.name, p.note]));

  const settled: Claim[] = [];
  const withheld: Withheld[] = [];

  for (const inquiry of INQUIRIES) {
    const found: Claim[] = [];

    for (const subject of await inquiry.subjects(vault, { studentDomain })) {
      const question = await inquiry.ask(vault, subject, { studentDomain, today });
      // No candidates, no question, no call. The cheapest abstention there is,
      // and on a real account it is most of them.
      if (!question) continue;

      /*
       * What earlier questions settled that bears on this one.
       *
       * Anything about this same subject, and anything about somebody who
       * could be the answer. That rule is general enough to cover every pair
       * of questions here without any of them naming another: the teacher
       * question wants the roles of its candidates, and the question about
       * whether a course is running wants to know what kind of thing it is.
       */
      const known = settled
        .filter((c) => c.subject === subject || carriesCandidate(c, question.candidates, noteOf))
        .map((c) => `${named.get(c.subject) ?? c.subject} ${c.relation} ${phrase(c)}.`);

      // Whether a co-holder is a rival is a property of the question, and the
      // refuter cannot tell which it is looking at unless it is told.
      found.push(
        ...(await interpret({ llm }, { ...question, known, several: !inquiry.single }, { userId })),
      );
    }

    /*
     * Settled per inquiry, not once at the end.
     *
     * Contention is between readings of the same slot, and a slot belongs to
     * one question. Pooling every relation before settling would let claims
     * that were never rivals be compared, and the answers have to be available
     * to the questions that come after anyway.
     */
    const done = settle(found, { single: inquiry.single ? [inquiry.relation] : [] });
    settled.push(...done.settled);
    withheld.push(...done.withheld);
  }

  return { settled, withheld };
}

/** Whether a claim is about somebody who could answer this question. */
function carriesCandidate(
  claim: Claim,
  candidates: readonly string[],
  noteOf: ReadonlyMap<string, string>,
): boolean {
  return candidates.some((c) => noteOf.get(c) === claim.subject);
}

/** The object with whatever limits it, as one phrase. */
const phrase = (claim: Claim) =>
  claim.qualifier ? `${claim.object}, ${claim.qualifier}` : claim.object;
