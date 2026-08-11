export type MemoryKind = 'conversation' | 'observation' | 'tool_result' | 'reflection';

export interface EpisodicMemory {
  id: string;
  agentId: string;
  kind: MemoryKind;
  content: string;
  source: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
}

export interface MemorySummary {
  id: string;
  agentId: string;
  periodStart: Date;
  periodEnd: Date;
  summary: string;
  sourceMemoryIds: string[];
  createdAt: Date;
}

export interface RecordMemoryInput {
  agentId: string;
  kind: MemoryKind;
  content: string;
  source: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Persistent memory for one agent.
 *
 * `recall` returns what should go into the model's context for this turn -- not
 * everything the agent knows. Today that means recent episodic entries plus the
 * latest summaries; when that stops being good enough, this method gains
 * semantic search and NOTHING ELSE CHANGES. That is the reason it is an
 * interface rather than a set of loose query functions.
 */
export interface MemoryStore {
  record(input: RecordMemoryInput): Promise<EpisodicMemory>;
  recall(agentId: string, options?: RecallOptions): Promise<RecalledMemory>;
  /** Episodic entries not yet covered by a summary. Used by the rollup job. */
  unsummarized(agentId: string, before: Date): Promise<EpisodicMemory[]>;
  saveSummary(input: Omit<MemorySummary, 'id' | 'createdAt'>): Promise<MemorySummary>;
}

export interface RecallOptions {
  /** Cap on recent episodic entries. Keep this small -- context is the budget. */
  limit?: number;
  /** Free-text hint. Ignored today; the hook for semantic recall later. */
  query?: string;
}

export interface RecalledMemory {
  recent: EpisodicMemory[];
  summaries: MemorySummary[];
}
