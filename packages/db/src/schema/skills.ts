import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * A capability an agent has accumulated.
 *
 * The Hermes-style bet is that `origin: 'learned'` rows get written by the
 * agent itself as it discovers procedures that work, and that this is what
 * makes an agent feel like it belongs to one student rather than being a
 * generic assistant.
 *
 * Nothing writes 'learned' yet. The learning loop is a separate design problem
 * -- when to promote a one-off success into a durable skill, how to revise one
 * that starts failing, how to stop the set growing without bound. See
 * packages/agent/src/skills/registry.ts.
 */
export const agentSkills = pgTable(
  'agent_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** The procedure itself, in natural language. Injected into the prompt. */
    instructions: text('instructions').notNull(),
    /** Tool ids this skill is permitted to call. */
    toolIds: jsonb('tool_ids').$type<string[]>().notNull().default([]),
    /** 'builtin' | 'learned' -- see @contexto/shared skillOriginSchema. */
    origin: text('origin').notNull().default('builtin'),
    /** Bumped on every revision so a regression can be traced. */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_skills_agent_id_idx').on(t.agentId)],
);
