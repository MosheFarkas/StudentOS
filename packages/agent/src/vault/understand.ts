import type { LlmProvider } from '@contexto/llm';
import { settle, type Settlement } from './claims.js';
import { askWhatTheyDo, askWhoTeaches, staffRoster } from './evidence.js';
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
const SINGLE = ['taught by', 'works at the school as'];

export async function understandVault(
  { llm }: UnderstandDeps,
  vault: Vault,
  { userId, studentDomain }: UnderstandOptions,
): Promise<Settlement> {
  /*
   * What people are, before what they did.
   *
   * Every wrong teacher left in the corpus was a role mistaken for a job: a
   * head of year setting deadlines, a librarian chasing books, a colleague
   * covering one lesson, a trainee taking some of them. All four look exactly
   * like teaching inside a single course, and the sentence that says otherwise
   * sits in a note about some other class -- so no course-sized view can
   * reach it, and every course-sized view concludes, reasonably, that they
   * teach.
   *
   * Asking per person across everything puts that sentence where it is needed.
   * It is also cheaper than the alternative it replaces, which is the same
   * question re-answered badly once per person per course.
   */
  const roster = await staffRoster(vault, studentDomain);

  const roleClaims = [];
  for (const person of roster) {
    const question = await askWhatTheyDo(vault, person.note, studentDomain);
    if (!question) continue;
    const claim = await interpret({ llm }, question, { userId });
    if (claim) roleClaims.push(claim);
  }

  const roles = settle(roleClaims, { single: SINGLE });
  const roleOf = new Map(
    roles.settled.map((c) => [c.subject, c.qualifier ? `${c.object}, ${c.qualifier}` : c.object]),
  );

  const courses = (await vault.list('entity')).filter((n) => n.description === 'Course');

  const claims = [];
  for (const course of courses) {
    const question = await askWhoTeaches(vault, course.name, studentDomain);
    // No candidates, no question, no call. The cheapest abstention there is,
    // and on a real account it is most of them.
    if (!question) continue;

    /** Only the roles of people who could be the answer here. */
    const known = roster
      .filter((p) => roleOf.has(p.note) && question.candidates.includes(p.name))
      .map((p) => `${p.name} works at the school as ${roleOf.get(p.note) as string}.`);

    const claim = await interpret({ llm }, { ...question, known }, { userId });
    if (claim) claims.push(claim);
  }

  const taught = settle(claims, { single: SINGLE });

  return {
    settled: [...roles.settled, ...taught.settled],
    withheld: [...roles.withheld, ...taught.withheld],
  };
}
