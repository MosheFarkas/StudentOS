import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * Integrations a student has switched OFF.
 *
 * Stores only the exceptions: no row means enabled. That keeps "connected and
 * working" the default, so adding a new integration does not require
 * backfilling a row for every existing student.
 *
 * Deliberately separate from the OAuth grant. Turning Gmail off should not
 * force a student through Google's consent screen again to turn it back on --
 * revoking is a heavier, slower action they can still take at Google itself.
 * This is the light switch; the grant is the wiring.
 */
export const disabledIntegrations = pgTable(
  'disabled_integrations',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** A ScopeGroup: 'classroom' | 'drive' | 'gmail'. */
    integration: text('integration').notNull(),
    createdAt: timestamp('created_at')
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.integration] })],
);
