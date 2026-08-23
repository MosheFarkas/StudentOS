import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '@contexto/db';
import { agentMemories, agents } from '@contexto/db';
import type { ProfileStore } from './profile.js';

/** Postgres-backed profile storage. Two columns on the agent row. */
export class PostgresProfileStore implements ProfileStore {
  constructor(private readonly db: Database) {}

  async read(agentId: string): Promise<{ profile: string; updatedAt: Date | null } | null> {
    const [row] = await this.db
      .select({ profile: agents.profile, updatedAt: agents.profileUpdatedAt })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    return row ? { profile: row.profile, updatedAt: row.updatedAt } : null;
  }

  async save(agentId: string, profile: string, at: Date): Promise<void> {
    await this.db
      .update(agents)
      .set({ profile, profileUpdatedAt: at })
      .where(eq(agents.id, agentId));
  }

  /**
   * Agents whose memory has moved on since their profile was written.
   *
   * An EXISTS rather than a join and a group-by: the question is whether there
   * is at least one newer exchange, and Postgres can stop at the first one it
   * finds instead of counting them all.
   */
  async stale(limit: number): Promise<{ agentId: string; userId: string }[]> {
    const rows = await this.db
      .select({ agentId: agents.id, userId: agents.userId })
      .from(agents)
      .where(
        sql`exists (${this.db
          .select({ one: sql`1` })
          .from(agentMemories)
          .where(
            and(
              eq(agentMemories.agentId, agents.id),
              or(
                isNull(agents.profileUpdatedAt),
                gt(agentMemories.occurredAt, agents.profileUpdatedAt),
              ),
            ),
          )})`,
      )
      .limit(limit);

    return rows;
  }
}
