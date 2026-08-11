import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * Episodic memory: an append-only log of things that happened.
 *
 * Deliberately NOT a vector store. The retrieval strategy for v1 is recency +
 * agent scoping + the rolled-up summaries below, which is sufficient while an
 * agent's history is small and costs nothing extra to operate.
 *
 * When recency stops being good enough, the upgrade is an `embedding
 * vector(1536)` column on this table plus an HNSW index -- the local Postgres
 * image (docker-compose.yml) already ships pgvector, so that is a migration,
 * not new infrastructure. Do not reach for a dedicated vector database.
 */
export const agentMemories = pgTable(
  'agent_memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** e.g. 'conversation' | 'observation' | 'tool_result' | 'reflection' */
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    /** Where this came from: a tool id, 'user', 'agent'. */
    source: text('source').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /**
     * When the remembered thing happened, which is not always when we wrote the
     * row -- a calendar event imported on Monday may have occurred last Friday.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // TODO(memory): add when recency-based recall stops being good enough.
    // embedding: vector('embedding', { dimensions: 1536 }),
  },
  (t) => [
    index('agent_memories_agent_occurred_idx').on(t.agentId, t.occurredAt),
    // TODO(memory): index('agent_memories_embedding_idx').using('hnsw', ...)
  ],
);

/**
 * Periodic rollups produced by the summarisation job in apps/worker.
 *
 * These are what actually go into an agent's context window -- the raw episodic
 * log is far too large to send, and gets larger every day. Summaries are the
 * mechanism that keeps context cost flat as an agent's history grows.
 */
export const agentMemorySummaries = pgTable(
  'agent_memory_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    summary: text('summary').notNull(),
    /** Which episodic rows this summarises, so the job is idempotent. */
    sourceMemoryIds: jsonb('source_memory_ids').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_memory_summaries_agent_period_idx').on(t.agentId, t.periodStart)],
);
