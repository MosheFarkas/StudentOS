import { and, asc, desc, eq, lt, notInArray, sql } from 'drizzle-orm';
import type { Database } from '@studentos/db';
import { agentMemories, agentMemorySummaries } from '@studentos/db';
import type {
  EpisodicMemory,
  MemoryStore,
  MemorySummary,
  RecallOptions,
  RecalledMemory,
  RecordMemoryInput,
} from './types.js';

const DEFAULT_RECALL_LIMIT = 20;
const DEFAULT_SUMMARY_LIMIT = 5;

/**
 * Postgres-backed episodic memory.
 *
 * Recall is recency-ordered, scoped to one agent. No embeddings, no vector
 * index, no extra service -- and for an agent with a few weeks of history that
 * is genuinely the right answer, not a placeholder for one.
 *
 * The upgrade, when recall quality actually degrades, is an `embedding` column
 * on agent_memories and a semantic branch inside `recall()` when
 * `options.query` is set. It stays behind this interface.
 */
export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly db: Database) {}

  async record(input: RecordMemoryInput): Promise<EpisodicMemory> {
    const [row] = await this.db
      .insert(agentMemories)
      .values({
        agentId: input.agentId,
        kind: input.kind,
        content: input.content,
        source: input.source,
        metadata: input.metadata ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();

    if (!row) throw new Error('Failed to record memory');
    return toEpisodic(row);
  }

  async recall(agentId: string, options: RecallOptions = {}): Promise<RecalledMemory> {
    const limit = options.limit ?? DEFAULT_RECALL_LIMIT;

    // TODO(memory): when options.query is set and embeddings exist, run a
    // similarity search here and merge with the recency window.

    const [recent, summaries] = await Promise.all([
      this.db
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.agentId, agentId))
        .orderBy(desc(agentMemories.occurredAt))
        .limit(limit),
      this.db
        .select()
        .from(agentMemorySummaries)
        .where(eq(agentMemorySummaries.agentId, agentId))
        .orderBy(desc(agentMemorySummaries.periodStart))
        .limit(DEFAULT_SUMMARY_LIMIT),
    ]);

    return {
      // Reversed so the model reads them oldest-first, as a narrative.
      recent: recent.map(toEpisodic).reverse(),
      summaries: summaries.map(toSummary),
    };
  }

  async unsummarized(agentId: string, before: Date): Promise<EpisodicMemory[]> {
    // Ids already covered by a summary, so re-running the job is idempotent.
    const covered = this.db
      .select({
        id: sql<string>`jsonb_array_elements_text(${agentMemorySummaries.sourceMemoryIds})`.as(
          'id',
        ),
      })
      .from(agentMemorySummaries)
      .where(eq(agentMemorySummaries.agentId, agentId));

    const rows = await this.db
      .select()
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.agentId, agentId),
          lt(agentMemories.occurredAt, before),
          notInArray(agentMemories.id, covered),
        ),
      )
      .orderBy(asc(agentMemories.occurredAt));

    return rows.map(toEpisodic);
  }

  async saveSummary(input: Omit<MemorySummary, 'id' | 'createdAt'>): Promise<MemorySummary> {
    const [row] = await this.db
      .insert(agentMemorySummaries)
      .values({
        agentId: input.agentId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        summary: input.summary,
        sourceMemoryIds: input.sourceMemoryIds,
      })
      .returning();

    if (!row) throw new Error('Failed to save memory summary');
    return toSummary(row);
  }
}

function toEpisodic(row: typeof agentMemories.$inferSelect): EpisodicMemory {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind as EpisodicMemory['kind'],
    content: row.content,
    source: row.source,
    metadata: row.metadata ?? undefined,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function toSummary(row: typeof agentMemorySummaries.$inferSelect): MemorySummary {
  return {
    id: row.id,
    agentId: row.agentId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    summary: row.summary,
    sourceMemoryIds: row.sourceMemoryIds,
    createdAt: row.createdAt,
  };
}
