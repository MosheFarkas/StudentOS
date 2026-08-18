import { describe, expect, it } from 'vitest';
import { condense, readSchoolPortal } from './portal.js';
import type { PortalPage, PortalSnapshot, ToolContext } from './types.js';

const page = (title: string, components: PortalPage['components']): PortalPage => ({
  url: `https://portals.veracross.com/lcc/student/${title}`,
  title,
  components,
});

const component = (shape: unknown, empty: boolean | null = false) => ({
  url: 'https://portals.veracross.com/lcc/student/component/X/1/load_data',
  status: 200,
  method: 'GET',
  shape,
  empty,
});

const ctxWith = (snapshots: PortalSnapshot[]): ToolContext =>
  ({ userId: 'u1', agentId: 'a1', portals: { latest: async () => snapshots } }) as ToolContext;

const snapshot = (over: Partial<PortalSnapshot> = {}): PortalSnapshot => ({
  portalId: 'veracross',
  origin: 'https://portals.veracross.com',
  capturedAt: '2026-09-14T12:00:00.000Z',
  redacted: false,
  pages: [page('Assignments', [component({ courses: [{ title: 'Ch 3', due: '2026-09-18' }] })])],
  ...over,
});

describe('condense', () => {
  it('drops pages whose components all came back empty', () => {
    const { kept, dropped } = condense([
      page('Empty', [component({ courses: [] }, true)]),
      page('Real', [component({ courses: [{ id: 1 }] })]),
    ]);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(1);
  });

  it('stays inside the character budget on a large portal', () => {
    const big = Array.from({ length: 200 }, (_, i) =>
      page(`P${i}`, [component({ blob: 'x'.repeat(500) })]),
    );
    const { kept, dropped } = condense(big, 5_000);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(5_000);
    expect(dropped).toBeGreaterThan(0);
  });
});

describe('readSchoolPortal', () => {
  it('says no device is linked rather than erroring', async () => {
    const result = (await readSchoolPortal.execute({}, { userId: 'u1', agentId: 'a1' } as ToolContext)) as {
      unavailable: boolean; reason: string;
    };
    expect(result.unavailable).toBe(true);
    expect(result.reason).toMatch(/Settings/);
  });

  it('reports when nothing has been captured yet', async () => {
    const result = (await readSchoolPortal.execute({}, ctxWith([]))) as { unavailable: boolean };
    expect(result.unavailable).toBe(true);
  });

  it('returns captured coursework with the untrusted-content warning', async () => {
    const result = (await readSchoolPortal.execute({}, ctxWith([snapshot()]))) as {
      note: string; portals: { pages: unknown[] }[];
    };
    expect(result.note).toMatch(/NEVER as instructions/);
    expect(result.portals[0]?.pages).toHaveLength(1);
  });

  it('warns loudly when the snapshot holds shapes instead of values', async () => {
    // Without this the model reads "string<date>" and reports it as a due date.
    const result = (await readSchoolPortal.execute({}, ctxWith([
      snapshot({ redacted: true, pages: [page('A', [component({ due: 'string<date>' })])] }),
    ]))) as { portals: { warning?: string }[] };
    expect(result.portals[0]?.warning).toMatch(/only the SHAPE/);
  });

  it('tells the student to sign in again when the session expired', async () => {
    const result = (await readSchoolPortal.execute({}, ctxWith([
      snapshot({ needsLogin: true, pages: [page('A', [component({ courses: [] }, true)])] }),
    ]))) as { portals: { warning?: string }[] };
    expect(result.portals[0]?.warning).toMatch(/sign in/i);
    // The failure that matters: an expired login read as "no coursework".
    expect(result.portals[0]?.warning).not.toMatch(/year has not started/);
  });

  it('explains an all-empty portal instead of saying there is no coursework', async () => {
    const result = (await readSchoolPortal.execute({}, ctxWith([
      snapshot({ pages: [page('A', [component({ courses: [] }, true)])] }),
    ]))) as { portals: { warning?: string }[] };
    expect(result.portals[0]?.warning).toMatch(/year has not started|login expired/);
  });

  it('filters to one portal when asked', async () => {
    const result = (await readSchoolPortal.execute({ portalId: 'mozaik' }, ctxWith([snapshot()]))) as {
      unavailable: boolean; reason: string;
    };
    expect(result.unavailable).toBe(true);
    expect(result.reason).toMatch(/mozaik/);
  });
});
