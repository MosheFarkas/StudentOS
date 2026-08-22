import type { AgentActivity } from '@contexto/shared';

/**
 * Which conversations have a turn running right now, and what it is doing.
 *
 * A turn outlives the request that asked for it, deliberately -- closing the
 * window mid-answer should not throw the answer away. But that leaves a page
 * loaded afterwards with no way to know anything is happening: the student's
 * question is saved, no reply exists yet, and nothing on screen says one is
 * coming. They see a question they asked apparently ignored, and then an
 * answer arrives out of nowhere a minute later.
 *
 * Held in memory rather than the database on purpose. A turn cannot outlive
 * the process running it, so a restart losing this is exactly right: the
 * turns it described died with it, and a row saying otherwise would be a lie
 * that survived.
 *
 * Counted, not a flag. A student can be answered in the app and over Telegram
 * at once, and the first to finish must not clear the other.
 */
interface InFlight {
  count: number;
  /**
   * The last step reported, if anything has reported one.
   *
   * Kept beside the count rather than in a map of its own so the two cannot
   * drift: an activity that outlived its turn would have the conversation
   * announcing work that finished minutes ago. Two overlapping turns share
   * the one slot and the later report wins -- both are genuinely this
   * conversation's work, and the student is owed the more recent of them.
   */
  activity?: AgentActivity;
}

const running = new Map<string, InFlight>();

export function beginTurn(agentId: string): void {
  const now = running.get(agentId);
  if (now) now.count += 1;
  else running.set(agentId, { count: 1 });
}

export function endTurn(agentId: string): void {
  const now = running.get(agentId);
  if (!now) return;
  now.count -= 1;
  // Dropping the entry drops the activity with it, which is the point: the
  // last thing a finished turn was doing is not something to keep saying.
  if (now.count <= 0) running.delete(agentId);
}

/** Whether anything is currently working on this conversation. */
export function turnRunning(agentId: string): boolean {
  return (running.get(agentId)?.count ?? 0) > 0;
}

/**
 * Note what the running turn is on.
 *
 * Ignored when nothing is running. A turn that has already unwound must not
 * be able to plant a label with nothing left to come along and clear it.
 */
export function setActivity(agentId: string, activity: AgentActivity): void {
  const now = running.get(agentId);
  if (now) now.activity = activity;
}

/** What this conversation is doing, if it is doing anything. */
export function turnActivity(agentId: string): AgentActivity | undefined {
  return running.get(agentId)?.activity;
}

/** Tests only: forget everything, so one test cannot colour the next. */
export function resetTurns(): void {
  running.clear();
}
