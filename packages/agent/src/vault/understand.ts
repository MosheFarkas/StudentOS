import type { LlmProvider } from '@contexto/llm';
import { settle, type Settlement } from './claims.js';
import { askWhoTeaches } from './evidence.js';
import { interpret } from './interpret.js';
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
}

/**
 * Relations admitting exactly one answer per subject.
 *
 * A cardinality, not a vocabulary. Anything not named here passes through
 * holding as many objects as the evidence supports, so the relation names stay
 * open -- a closed list would have had no slot for a house, a form tutor or a
 * coach, and would have flattened all three into "teaches", which is the
 * mistake this exists to stop.
 */
const SINGLE = ['taught by'];

export async function understandVault(
  { llm }: UnderstandDeps,
  vault: Vault,
  { userId, studentDomain }: UnderstandOptions,
): Promise<Settlement> {
  const courses = (await vault.list('entity')).filter((n) => n.description === 'Course');

  const claims = [];
  for (const course of courses) {
    const question = await askWhoTeaches(vault, course.name, studentDomain);
    // No candidates, no question, no call. The cheapest abstention there is,
    // and on a real account it is most of them.
    if (!question) continue;

    const claim = await interpret({ llm }, question, { userId });
    if (claim) claims.push(claim);
  }

  return settle(claims, { single: SINGLE });
}
