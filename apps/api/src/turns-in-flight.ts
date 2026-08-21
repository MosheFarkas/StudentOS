/**
 * Which conversations have a turn running right now.
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
const running = new Map<string, number>();

export function beginTurn(agentId: string): void {
  running.set(agentId, (running.get(agentId) ?? 0) + 1);
}

export function endTurn(agentId: string): void {
  const left = (running.get(agentId) ?? 0) - 1;
  if (left > 0) running.set(agentId, left);
  else running.delete(agentId);
}

/** Whether anything is currently working on this conversation. */
export function turnRunning(agentId: string): boolean {
  return (running.get(agentId) ?? 0) > 0;
}

/** Tests only: forget everything, so one test cannot colour the next. */
export function resetTurns(): void {
  running.clear();
}
