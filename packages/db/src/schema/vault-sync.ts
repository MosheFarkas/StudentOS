import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * Where the live sync stands for one student.
 *
 * Small on purpose: a Drive change token, the two Google watches and when
 * each tier last ran. The vault itself stays on disk; this is the bookmark.
 */
export const vaultSync = pgTable(
  'vault_sync',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Where the next Drive changes.list starts. */
    drivePageToken: text('drive_page_token'),
    driveChannelId: text('drive_channel_id'),
    driveResourceId: text('drive_resource_id'),
    /** Echoed by Drive on every notification, so a forged one is refused. */
    driveChannelSecret: text('drive_channel_secret'),
    driveChannelExpiresAt: timestamp('drive_channel_expires_at', { withTimezone: true }),
    gmailWatchExpiresAt: timestamp('gmail_watch_expires_at', { withTimezone: true }),
    /**
     * The school's mail domains, found by the slow refresh.
     *
     * Discovery reads hundreds of sent messages, so the live sync must not
     * repeat it on every bell.
     */
    schoolDomains: jsonb('school_domains').$type<string[]>(),
    lastLiveSyncAt: timestamp('last_live_sync_at', { withTimezone: true }),
    lastRefreshAt: timestamp('last_refresh_at', { withTimezone: true }),
  },
  (t) => [index('vault_sync_drive_channel_id_idx').on(t.driveChannelId)],
);
