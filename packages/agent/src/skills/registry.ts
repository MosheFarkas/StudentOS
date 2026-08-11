import { and, eq } from 'drizzle-orm';
import type { Database } from '@studentos/db';
import { agentSkills } from '@studentos/db';
import type { SkillOrigin } from '@studentos/shared';
import type { Skill, SkillRegistry, UpsertSkillInput } from './types.js';

/** Postgres-backed skill storage. */
export class PostgresSkillRegistry implements SkillRegistry {
  constructor(private readonly db: Database) {}

  async list(agentId: string): Promise<Skill[]> {
    const rows = await this.db.select().from(agentSkills).where(eq(agentSkills.agentId, agentId));
    return rows.map(toSkill);
  }

  async get(agentId: string, skillId: string): Promise<Skill | null> {
    const [row] = await this.db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.id, skillId)))
      .limit(1);
    return row ? toSkill(row) : null;
  }

  async upsert(input: UpsertSkillInput): Promise<Skill> {
    const [existing] = await this.db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, input.agentId), eq(agentSkills.name, input.name)))
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(agentSkills)
        .set({
          description: input.description,
          instructions: input.instructions,
          toolIds: input.toolIds ?? existing.toolIds,
          // Version bumps on every revision, so a skill that starts producing
          // bad behaviour can be traced to the edit that caused it.
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(agentSkills.id, existing.id))
        .returning();

      if (!updated) throw new Error('Failed to update skill');
      return toSkill(updated);
    }

    const [created] = await this.db
      .insert(agentSkills)
      .values({
        agentId: input.agentId,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        toolIds: input.toolIds ?? [],
        origin: input.origin ?? 'builtin',
      })
      .returning();

    if (!created) throw new Error('Failed to create skill');
    return toSkill(created);
  }

  async remove(agentId: string, skillId: string): Promise<void> {
    await this.db
      .delete(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.id, skillId)));
  }
}

function toSkill(row: typeof agentSkills.$inferSelect): Skill {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    toolIds: row.toolIds,
    origin: row.origin as SkillOrigin,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/*
 * TODO(skills): the learning loop -- how a skill with origin 'learned' ever
 * gets written. This is the central product bet and is deliberately NOT
 * scaffolded, because the hard parts are judgement calls, not plumbing:
 *
 *   PROMOTION   What earns a one-off success a permanent slot? Doing it after
 *               every successful run fills the set with noise within a week.
 *               Repetition is the obvious signal; explicit student confirmation
 *               is the honest one.
 *
 *   REVISION    A skill that used to work and now fails needs to change, but
 *               the agent finding out it failed is itself unsolved.
 *
 *   FORGETTING  Skills must be able to die. An agent whose skill set only grows
 *               ends up with a context window full of stale procedures, and
 *               gets worse over time rather than better -- the exact opposite
 *               of the pitch.
 *
 *   VISIBILITY  Students should see and edit what their agent has learned.
 *               A self-modifying agent whose changes are invisible is one bad
 *               inference away from feeling broken and untrustworthy.
 *
 * Design this as its own session. The storage layer above is ready for it.
 */
