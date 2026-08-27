import { type ProfileStore } from './profile.js';
import type { MemoryStore } from './types.js';

/**
 * Gathering up what a student said, once they have stopped saying it.
 *
 * This runs between conversations, never during one. What it hands back is fed
 * to the page of what has been learned about them -- and that page is pinned in
 * the cached part of every system prompt, so rewriting it mid-turn would
 * invalidate that prefix for the rest of the conversation. Doing the work on a
 * background job is what makes it a frozen snapshot instead.
 *
 * It used to write a profile itself, per agent. That was the flaw: a student
 * with three agents had to tell each of them separately that they read on a
 * phone and cannot take long answers. What it collects now goes to one page
 * that belongs to the student, so anything they say once is known everywhere.
 *
 * The two columns behind ProfileStore survive as the watermark. They record
 * when an agent's memory was last CONSIDERED, which is what stops the job
 * re-reading the same exchanges to reach the same conclusion on every wake.
 */

/** How many recent exchanges one pass will look at. */
const MAX_EXCHANGES_PER_PASS = 40;

export interface ExchangeCollectorDeps {
  memory: MemoryStore;
  profiles: ProfileStore;
}

export interface CollectedExchanges {
  /**
   * The exchanges since this agent was last considered, oldest first.
   *
   * A conversation is not a row anywhere -- it is exactly this: what was said
   * between one quiet period and the next.
   */
  exchanges: string[];
  /** Newest entry considered. Stable id for the burst, so a rerun is a lookup. */
  newestId?: string;
  /** When the last of it happened. */
  occurred?: string;
  /** What was previously known about this student, from the profile being retired. */
  knownBefore?: string;
}

export interface ExchangeCollectorOptions {
  agentId: string;
  userId: string;
  now?: Date;
}

/**
 * Take the exchanges one agent has had since it was last looked at.
 *
 * Costs nothing when nothing has happened since, which is the common case by a
 * wide margin: a job on a timer that pays for a model call every time it wakes
 * has a bill that scales with uptime rather than with use.
 */
export async function collectExchanges(
  { memory, profiles }: ExchangeCollectorDeps,
  options: ExchangeCollectorOptions,
): Promise<CollectedExchanges> {
  const now = options.now ?? new Date();
  const existing = await profiles.read(options.agentId);
  const since = existing?.updatedAt ?? null;

  const { recent } = await memory.recall(options.agentId, { limit: MAX_EXCHANGES_PER_PASS });
  const fresh = since ? recent.filter((entry) => entry.occurredAt > since) : recent;

  if (fresh.length === 0) return { exchanges: [] };

  /*
   * Move the watermark either way.
   *
   * It records when this agent's memory was last CONSIDERED, not when anything
   * changed. Leaving it alone on a pass that decided nothing was worth keeping
   * leaves the agent permanently stale, and the job re-reads the same exchanges
   * to reach the same conclusion on every wake. Production had two agents in
   * exactly that state within an hour of the previous version shipping.
   */
  const previous = existing?.profile ?? '';
  await profiles.save(options.agentId, previous, now);

  const newest = fresh[fresh.length - 1];
  return {
    exchanges: fresh.map((entry) => entry.content),
    ...(newest ? { newestId: newest.id, occurred: newest.occurredAt.toISOString() } : {}),
    /*
     * What this agent already knew, handed on once.
     *
     * The migration, and there is no SQL in it. Every student has per-agent
     * profiles today; passing them to the first write of the shared page means
     * nobody loses what was learned about them on the day this ships.
     */
    ...(previous.trim() ? { knownBefore: previous.trim() } : {}),
  };
}
