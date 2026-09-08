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
  const rows = [
    { userId: 'alice', agentId: 'a1' },
    { userId: 'alice', agentId: 'a2' },
    { userId: 'bob', agentId: null },
    { userId: 'cara', agentId: 'c1' },
  ];
  const at = (iso: string) => new Date(iso);

  it('visits a student once however many agents they have, and includes one with none', () => {
    expect(studentsToRefresh(rows, new Map())).toEqual(['alice', 'bob', 'cara']);
  });

  it('puts the never-refreshed first, then the stalest', () => {
    const last = new Map([
      ['alice', at('2026-09-07T06:00:00Z')],
      ['bob', at('2026-09-06T06:00:00Z')],
      ['cara', null],
    ]);
    expect(studentsToRefresh(rows, last)).toEqual(['cara', 'bob', 'alice']);
  });

  it('can keep only the overdue', () => {
    const last = new Map([
      ['alice', at('2026-09-07T06:00:00Z')],
      ['bob', at('2026-09-06T06:00:00Z')],
    ]);
    const overdueBefore = at('2026-09-07T00:00:00Z');
    expect(studentsToRefresh(rows, last, { overdueBefore })).toEqual(['cara', 'bob']);
  });

  it('copes with nobody at all', () => {
    expect(studentsToRefresh([], new Map())).toEqual([]);
  });
});
