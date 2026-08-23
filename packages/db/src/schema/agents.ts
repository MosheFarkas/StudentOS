import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * A student-built agent.
 *
 * Note the ownership model: agents belong to a student, not to a course or an
 * institution. A school partnership provisions students; it never owns or
 * configures their agents.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Student-authored, in their own words. Feeds the system prompt. */
    purpose: text('purpose').notNull().default(''),
    /**
     * What the agent has learned about this student, in its own words.
     *
     * Rewritten by the summarisation job between conversations and pinned in
     * the cached part of the system prompt, which is why it is bounded rather
     * than allowed to grow -- see PROFILE_CHAR_LIMIT in packages/agent.
     */
    profile: text('profile').notNull().default(''),
    /**
     * When the profile last changed.
     *
     * The writer reads only the exchanges since this, so a conversation that
     * taught it nothing costs one cheap call rather than a rewrite from the
     * whole history. Null until the first one is written.
     */
    profileUpdatedAt: timestamp('profile_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agents_user_id_idx').on(t.userId)],
);
