import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { agents } from './agents.js';

/**
 * A student's own API key, encrypted at rest.
 *
 * Nothing here is readable without the master key -- a database dump alone is
 * not enough to use these keys. Columns are base64 text rather than bytea
 * purely to avoid a Drizzle custom type; the payloads are ~100 bytes.
 *
 * See packages/llm/src/crypto for the scheme and its documented upgrade path.
 */
export const llmCredentials = pgTable(
  'llm_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 'openai' | 'anthropic' -- see @contexto/shared byokProviderSchema. */
    provider: text('provider').notNull(),
    /** Student-chosen, so they can tell two keys apart. */
    label: text('label').notNull(),
    /** Last 4 chars of the plaintext key. Safe to show; nothing else is. */
    last4: text('last4').notNull(),

    /** AES-256-GCM ciphertext, base64. */
    ciphertext: text('ciphertext').notNull(),
    /** 12-byte nonce, base64. Unique per encryption -- never reused. */
    iv: text('iv').notNull(),
    /** 16-byte GCM authentication tag, base64. */
    authTag: text('auth_tag').notNull(),
    /**
     * Which master key encrypted this row. Lets you rotate the master key by
     * writing new rows at version N+1 and back-filling the old ones, instead of
     * needing a flag day.
     */
    keyVersion: integer('key_version').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [index('llm_credentials_user_id_idx').on(t.userId)],
);

/**
 * One row per model call on the platform tier, for metering and quota.
 *
 * BYOK calls are recorded too (so students can see their own usage), but they
 * never count against a quota -- the student is paying the provider directly.
 * The quota check reads this table; see packages/llm/src/quota.ts.
 */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** 'openai' | 'anthropic' | 'platform'. */
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /**
     * Cached prompt-prefix tokens, billed at a large discount by every
     * provider. Tracked separately because caching -- not model choice -- is
     * the main lever on what the platform tier actually costs us.
     */
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    /** Integer micro-USD. Avoids float drift when summing millions of rows. */
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_usage_user_created_idx').on(t.userId, t.createdAt)],
);
