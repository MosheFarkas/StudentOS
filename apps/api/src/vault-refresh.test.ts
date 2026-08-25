import { describe, expect, it } from 'vitest';
import { studentsToRefresh } from './vault-refresh.js';

/**
 * Who the periodic refresh runs for.
 *
 * The vault used to belong to an agent, so the refresh looped over agents.
 * It belongs to the student now, and looping over agents survived the change
 * -- which breaks it at both ends.
 *
 * A student with two agents has their whole year imported twice on every
 * pass: every message fetched twice, every unread file read twice, the second
 * pass paying for work the first already did. And a student with no agents is
 * never refreshed at all, even though their vault is sitting there going
 * stale. Both cases exist on this deployment right now.
 */

describe('choosing whose vault to refresh', () => {
  it('visits a student once however many agents they have', () => {
    const rows = [
      { userId: 'alice', agentId: 'a1' },
      { userId: 'alice', agentId: 'a2' },
      { userId: 'alice', agentId: 'a3' },
      { userId: 'bob', agentId: 'b1' },
    ];

    expect(studentsToRefresh(rows, 10)).toEqual(['alice', 'bob']);
  });

  it('includes a student who has no agents at all', () => {
    /*
     * The account this was built against has none: they were deleted, and the
     * vault -- three and a half thousand notes -- remained, because it is
     * keyed by the student. Iterating agents would have left it to rot.
     */
    const rows = [
      { userId: 'alice', agentId: null },
      { userId: 'bob', agentId: 'b1' },
    ];

    expect(studentsToRefresh(rows, 10)).toEqual(['alice', 'bob']);
  });

  it('takes only as many students as the batch allows', () => {
    // The batch is there to bound one pass. Counting agents rather than
    // students made it bound something nobody cared about.
    const rows = [
      { userId: 'alice', agentId: 'a1' },
      { userId: 'alice', agentId: 'a2' },
      { userId: 'bob', agentId: 'b1' },
      { userId: 'carol', agentId: 'c1' },
    ];

    expect(studentsToRefresh(rows, 2)).toEqual(['alice', 'bob']);
  });

  it('copes with nobody at all', () => {
    expect(studentsToRefresh([], 5)).toEqual([]);
  });
});
