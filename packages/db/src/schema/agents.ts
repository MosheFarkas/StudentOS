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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agents_user_id_idx').on(t.userId)],
);
