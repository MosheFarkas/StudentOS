import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { agents } from './agents.js';

/**
 * A messaging account bound to one student's agent.
 *
 * The unique constraint on (channel, channel_user_id) is a security boundary,
 * not tidiness: it makes it impossible for one Telegram account to be linked to
 * two students, which is the shape a hijack would take.
 */
export const channelLinks = pgTable(
  'channel_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 'telegram' | 'discord' | 'sms' | 'whatsapp' */
    channel: text('channel').notNull(),
    /** The channel's own id for this person, and our reply address. */
    channelUserId: text('channel_user_id').notNull(),
    /** Which of the student's agents answers on this channel. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  },
  (t) => [
    unique('channel_links_channel_user_unique').on(t.channel, t.channelUserId),
    index('channel_links_user_idx').on(t.userId),
  ],
);

/**
 * Single-use codes that prove account ownership during linking.
 *
 * Identity is never inferred from a phone number or username -- the webhook is
 * public and anyone can claim to be anyone. A code shown only inside an
 * authenticated session is the thing a stranger cannot produce.
 *
 * Carries agentId because the student picks which agent answers at the moment
 * they generate the code.
 */
export const channelLinkCodes = pgTable(
  'channel_link_codes',
  {
    code: text('code').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** Short by design. A long-lived code is a long-lived way in. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('channel_link_codes_user_idx').on(t.userId)],
);
