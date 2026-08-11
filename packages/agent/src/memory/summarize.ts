import type { LlmRegistry } from '@studentos/llm';
import type { MemoryStore } from './types.js';

/**
 * Rolls episodic memory up into periodic summaries.
 *
 * STRUCTURE ONLY -- the model call is not wired up. Run from apps/worker.
 *
 * Why this job is the load-bearing part of the memory design: episodic memory
 * grows without bound, but the context window does not. Summaries are what keep
 * the cost of a turn flat as an agent accumulates months of history. Without
 * this job, memory works beautifully for two weeks and then gets expensive and
 * then stops fitting.
 */

export interface SummarizeOptions {
  agentId: string;
  /** Only summarise entries older than this, so recent memory stays verbatim. */
  before: Date;
  /** Skip if fewer than this many entries are pending -- avoids noise rollups. */
  minEntries?: number;
}

export interface SummarizerDeps {
  memory: MemoryStore;
  llm: LlmRegistry;
  /** Whose quota the summarisation call is billed against. */
  userId: string;
}

const DEFAULT_MIN_ENTRIES = 10;

export async function summarizeAgentMemory(
  { memory, llm, userId }: SummarizerDeps,
  options: SummarizeOptions,
): Promise<{ summarized: number }> {
  const pending = await memory.unsummarized(options.agentId, options.before);
  const minEntries = options.minEntries ?? DEFAULT_MIN_ENTRIES;

  if (pending.length < minEntries) {
    return { summarized: 0 };
  }

  void llm;
  void userId;

  // TODO(memory): the actual rollup.
  //
  //   1. Group `pending` into periods (daily is a reasonable starting point;
  //      per-conversation may work better and is worth testing).
  //   2. For each period, call llm.chat() with a summarisation prompt.
  //   3. memory.saveSummary({ ..., sourceMemoryIds: ids }) -- passing every id
  //      in the period is what makes re-running this job idempotent.
  //
  // The prompt is the whole game here and deserves real iteration. Two things
  // to design for from the start:
  //
  //   - Summarise for a READER THAT IS THE AGENT ITSELF, later, with none of
  //     this context. Preserve specifics -- names, dates, decisions, stated
  //     preferences. Generic recaps ("discussed coursework") are worthless and
  //     you will not notice they are worthless until recall quality drops.
  //   - Decide explicitly what is allowed to be forgotten. A summariser that
  //     never drops anything is just a slower copy of the episodic log.
  //
  // Bill this to the student whose agent it is -- see `userId` above. Doing it
  // on an unattributed key means summarisation cost is invisible until it is
  // the largest line on the bill.

  return { summarized: 0 };
}
