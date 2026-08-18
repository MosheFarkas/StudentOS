import { desc, eq } from 'drizzle-orm';
import type { Database } from '@contexto/db';
import { portalSnapshots } from '@contexto/db';
import type { PortalSnapshot, PortalSnapshotSource } from '@contexto/agent';

/**
 * The latest map of each portal a student's devices have captured.
 *
 * DISTINCT ON is the point: a device re-syncs on a schedule, so the table
 * accumulates a history per portal, and the agent only ever wants the newest
 * of each. Doing this in SQL rather than fetching every row and reducing in
 * JavaScript keeps a term's worth of snapshots off the heap.
 */
export class DbPortalSnapshots implements PortalSnapshotSource {
  constructor(private readonly db: Database) {}

  async latest(userId: string): Promise<PortalSnapshot[]> {
    const rows = await this.db
      .selectDistinctOn([portalSnapshots.portalId], {
        portalId: portalSnapshots.portalId,
        origin: portalSnapshots.origin,
        redacted: portalSnapshots.redacted,
        capturedAt: portalSnapshots.capturedAt,
        map: portalSnapshots.map,
      })
      .from(portalSnapshots)
      .where(eq(portalSnapshots.userId, userId))
      .orderBy(portalSnapshots.portalId, desc(portalSnapshots.capturedAt));

    return rows.map((row) => ({
      portalId: row.portalId,
      origin: row.origin,
      redacted: row.redacted,
      capturedAt: row.capturedAt.toISOString(),
      needsLogin: Boolean((row.map as { needsLogin?: boolean })?.needsLogin),
      // The map is stored opaque, so shape it here rather than trusting it.
      pages: Array.isArray((row.map as { pages?: unknown })?.pages)
        ? ((row.map as { pages: PortalSnapshot['pages'] }).pages ?? [])
        : [],
    }));
  }
}
