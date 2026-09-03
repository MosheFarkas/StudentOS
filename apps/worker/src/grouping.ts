/**
 * The stale chats of one student, gathered together.
 *
 * Staleness is tracked per chat -- that is where the watermark lives -- but
 * there is one page per student, and this is what keeps the two facts apart.
 * It mattered when a student had three agents. It matters far more now that a
 * chat is an agent: an afternoon of short conversations is a dozen rows out of
 * that query, and writing the page once per row would be a dozen model calls
 * racing to overwrite each other, with eleven of the results thrown away.
 *
 * In a file of its own rather than beside the job that calls it, because
 * src/index.ts starts the worker as a side effect of being imported. A test
 * reaching in there would boot the thing it is trying to test.
 */
export function groupByStudent(
  stale: readonly { agentId: string; userId: string }[],
): Map<string, string[]> {
  const byStudent = new Map<string, string[]>();
  for (const { agentId, userId } of stale) {
    byStudent.set(userId, [...(byStudent.get(userId) ?? []), agentId]);
  }
  return byStudent;
}
