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
     * When this agent's memory was last considered -- a watermark, not a
     * change log.
     *
     * It advances on every pass, including the ones that decide nothing is
     * worth keeping, which is most of them. Advancing it only on a change
     * leaves an agent permanently stale and re-read on every wake of the job,
     * for ever. Null until the first pass. The writer reads only the exchanges
     * after it.
     */
    profileUpdatedAt: timestamp('profile_updated_at', { withTimezone: true }),
    /*
     * Out of the rail, still in the vault.
     *
     * Timestamps rather than booleans, and both nullable: null is the ordinary
     * state, and when it is set the moment it happened is worth having --
     * "archived in June" is the thing a student needs to recognise a chat by
     * in a list of forty they have put away.
     *
     * Archiving deliberately touches nothing but this column. The transcript,
     * the memories and everything the chat taught chats.md stay exactly where
     * they were; it is a filter on one list, not a kind of deletion. Deleting
     * is the other thing, and it is a DELETE.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** Pinned to the top of the rail. Ordered by when, so the newest pin leads. */
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agents_user_id_idx').on(t.userId)],
);
