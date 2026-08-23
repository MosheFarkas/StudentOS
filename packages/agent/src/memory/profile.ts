/**
 * What the agent durably knows about one student.
 *
 * The tier the memory has never had. A turn already carries the last eight
 * exchanges and can search the rest on demand, but nothing durable about a
 * student was ever present unless it happened to fall inside those eight --
 * so "I revise by rewriting my notes", said once in September, was gone by
 * October. The memory eval fails that case on every single run, and no
 * retrieval improvement fixes it, because the agent does not know there is
 * anything to look for.
 *
 * This is a single evolving document per agent, rewritten by the
 * summarisation job between conversations and pinned in the system prompt --
 * which is also why it must be bounded. It sits in the cached prefix, so every
 * character is paid on every turn of every conversation.
 */

/**
 * The budget, in characters.
 *
 * Hermes runs an entire user model in 1,375 and the cap is the mechanism: a
 * bounded document forces the writer to decide what is worth keeping, which is
 * the difference between memory that is curated and memory that merely
 * accumulates. Slightly larger than Hermes' because no student is going to
 * prune this by hand -- the eviction decision falls entirely on the writer,
 * which deserves a little more room to make it.
 */
export const PROFILE_CHAR_LIMIT = 1400;

/**
 * Hold a profile to the budget, cutting at a sentence rather than a character.
 *
 * A profile truncated mid-word leaves the agent reading half a fact and
 * believing it. Sentences are the smallest unit that survives being cut after.
 */
export function capProfile(profile: string): string {
  const trimmed = profile.trim();
  if (trimmed.length <= PROFILE_CHAR_LIMIT) return trimmed;

  const window = trimmed.slice(0, PROFILE_CHAR_LIMIT);
  const lastSentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('.\n'),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
  );

  // No sentence break at all: one enormous run-on still has to fit.
  return lastSentence === -1 ? window.trimEnd() : window.slice(0, lastSentence + 1);
}

/**
 * Render the profile for the system prompt, or nothing at all.
 *
 * The budget gauge is Hermes' idea and earns its handful of tokens: an agent
 * that can see its document is nearly full has the information it needs to
 * replace something rather than append to it.
 */
export function profileSection(profile: string): string | null {
  const capped = capProfile(profile);
  if (capped === '') return null;

  return (
    `What you know about this student [${capped.length}/${PROFILE_CHAR_LIMIT} characters]:\n` +
    capped
  );
}

/**
 * Reading and writing the profile, and finding the agents that need one.
 *
 * Separate from MemoryStore because it is a different table and a different
 * lifecycle: memory is appended on every turn, the profile is rewritten
 * between conversations by a job that runs on its own clock.
 */
export interface ProfileStore {
  read(agentId: string): Promise<{ profile: string; updatedAt: Date | null } | null>;
  save(agentId: string, profile: string, at: Date): Promise<void>;
  /**
   * Agents whose memory has moved on since it was last considered, and who
   * have been quiet long enough that a rewrite will not land mid-conversation.
   *
   * Batched, because a query returning every agent works right up until it
   * very suddenly does not.
   */
  stale(limit: number, quietForMs: number): Promise<{ agentId: string; userId: string }[]>;
}
