import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Better Auth core tables.
 *
 * These field names are dictated by Better Auth's Drizzle adapter -- do not
 * rename them. If you add columns, add them here and Better Auth will leave
 * them alone.
 *
 * Regenerate after a Better Auth upgrade with:
 *   pnpm --filter @contexto/api exec better-auth generate
 * and diff the output against this file before applying.
 */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified')
    .$defaultFn(() => false)
    .notNull(),
  image: text('image'),
  /**
   * IANA timezone, captured from the browser.
   *
   * Not a Better Auth field -- ours. Without it the agent cannot turn
   * "tomorrow at 3pm" into a timestamp, so it either asks a clarifying
   * question every time or guesses wrong. Nullable because a Telegram-only
   * student may never load the web app; UTC is the fallback.
   */
  timezone: text('timezone'),
  /**
   * Exempts this account from the platform token allowance.
   *
   * Ours, not Better Auth's. The operator running the deployment pays for the
   * platform key and needs to use the product without metering themselves,
   * while students stay capped -- and before this the only lever was the
   * global quota, which raises the ceiling for everyone at once.
   *
   * Set deliberately, by hand, on specific accounts. There is intentionally
   * no way to grant it from inside the product.
   */
  /*
   * .default() and not .$defaultFn(): the latter is a JS-side default, so
   * drizzle-kit emits ADD COLUMN ... NOT NULL with no DEFAULT, which fails
   * outright on a table that already has rows. A real SQL default is what
   * makes this migration survive contact with production.
   */
  unlimitedUsage: boolean('unlimited_usage').default(false).notNull(),
  /**
   * What the agent calls them, when it is not what Google calls them.
   *
   * Null means "use the first name from the account", which is what almost
   * everyone will want and nobody should have to type. Set, it replaces the
   * name in greetings and is how the agent refers to them -- a student called
   * Alexander who has been Xan since primary school should be Xan here.
   */
  preferredName: text('preferred_name'),
  /**
   * 'light' | 'dark'. Null means follow the system.
   *
   * Stored rather than kept in the browser so it follows a student between
   * their phone and a library machine, which is the whole reason to have the
   * setting rather than a switch that forgets.
   */
  appearance: text('appearance'),
  createdAt: timestamp('created_at')
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp('updated_at')
    .$defaultFn(() => new Date())
    .notNull(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

/**
 * One row per linked provider account.
 *
 * For Google this is where the OAuth tokens live, and -- importantly for us --
 * `scope` records which scopes the student actually granted. That is how we
 * answer "has this student connected Gmail?" and "...Classroom?" without a
 * separate grants table. See packages/agent/src/tools/google/scopes.ts.
 */
export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at').$defaultFn(() => new Date()),
});
