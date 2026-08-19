import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * Desktop companions, and what they bring back.
 *
 * The droplet cannot reach a student's laptop -- it is behind NAT with no
 * public address -- so the connection is made the other way round: the desktop
 * app authenticates outward and pushes what it finds. That also means portal
 * data is already here when the agent is asked about it at midnight with the
 * laptop shut, which a pull-based design could never manage.
 */

/**
 * A short-lived link request, so a student never handles a raw token.
 *
 * The desktop app opens the browser at /link/<request_id>; the student, already
 * signed in, approves; the app polls and collects a token. Modelled on the
 * OAuth device grant, minus the parts we do not need.
 */
export const deviceLinkRequests = pgTable('device_link_requests', {
  /** Long random value. The only thing the desktop app holds before approval. */
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  deviceName: text('device_name').notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  /**
   * Set the moment a token is issued. A request is redeemable exactly once, so
   * a leaked link cannot be replayed into a second token.
   */
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A linked desktop install. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * SHA-256 of the token, never the token. A dump of this table does not let
     * anyone speak as a student's laptop.
     */
    tokenHash: text('token_hash').notNull().unique(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('devices_user_id_idx').on(t.userId),
    index('devices_token_hash_idx').on(t.tokenHash),
  ],
);

/**
 * The most recent map of a portal, stored whole.
 *
 * Deliberately opaque JSON rather than modelled courses and assignments. We
 * have seen exactly one Veracross response so far and it was empty, because the
 * school year has not started. Designing tables around imagined coursework
 * would bake in guesses; storing what the portal actually returned lets the
 * shape be read off real data once term begins.
 */
export const portalSnapshots = pgTable(
  'portal_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** Stable key for the portal, e.g. 'veracross'. */
    portalId: text('portal_id').notNull(),
    origin: text('origin').notNull(),
    /**
     * Whether values were captured, or only shapes. `.default()` rather than
     * `.$defaultFn()` on purpose -- the latter generates ADD COLUMN NOT NULL
     * with no DEFAULT, which fails against a table that already has rows.
     */
    redacted: boolean('redacted').notNull().default(true),
    map: jsonb('map').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('portal_snapshots_user_portal_idx').on(t.userId, t.portalId, t.capturedAt)],
);
