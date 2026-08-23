import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, agents, agentMemories, user, type Database } from '@contexto/db';
import { eq } from 'drizzle-orm';
import { PostgresMemoryStore } from './store.js';

/**
 * The search SQL, against a real database.
 *
 * The pure ranking has unit tests, but the half that decides which rows ever
 * reach it does not: an OR of one ILIKE per term, built by spreading an array
 * into drizzle's `or`. That query has never run anywhere. The last piece of
 * untested retrieval code shipped a tool that recalled almost nothing, so this
 * one gets exercised before it is trusted.
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://studentos:studentos@localhost:5432/contexto_test';

describe('PostgresMemoryStore.search', () => {
  let db: Database;
  let store: PostgresMemoryStore;
  let agentId: string;
  const userId = `search-test-${randomUUID()}`;

  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL, maxConnections: 2 });
    store = new PostgresMemoryStore(db);

    await db.insert(user).values({
      id: userId,
      name: 'Search Test',
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    const [agent] = await db
      .insert(agents)
      .values({ userId, name: 'search-test', purpose: 'testing' })
      .returning();
    agentId = agent!.id;

    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
    await db.insert(agentMemories).values([
      {
        agentId,
        kind: 'conversation',
        source: 'agent_run',
        content: 'Student: my chemistry teacher is Mr Ali\nAgent: Noted.',
        occurredAt: at(100),
      },
      {
        agentId,
        kind: 'conversation',
        source: 'agent_run',
        content: 'Student: i like chemistry\nAgent: Good.',
        occurredAt: at(50),
      },
      {
        agentId,
        kind: 'conversation',
        source: 'agent_run',
        content: 'Student: whats the capital of norway\nAgent: Oslo.',
        occurredAt: at(1),
      },
    ]);
  });

  afterAll(async () => {
    // Cascades through agents and agent_memories.
    await db.delete(user).where(eq(user.id, userId));
  });

  it('finds a row matching only some of the query', async () => {
    // The bug this whole change exists for: one ILIKE over the whole phrase
    // returned nothing, because the stored line never contains the question.
    const hits = await store.search(agentId, 'chemistry teacher name');
    expect(hits.map((h) => h.content).join(' ')).toContain('Mr Ali');
  });

  it('ranks the row matching more terms first', async () => {
    const hits = await store.search(agentId, 'chemistry teacher');
    expect(hits[0]?.content).toContain('Mr Ali');
  });

  it('returns nothing when no term appears', async () => {
    expect(await store.search(agentId, 'hockey fixtures')).toEqual([]);
  });

  it('returns nothing for a query that is entirely stopwords', async () => {
    // An empty term list must not become an OR of zero conditions, which
    // drizzle would render as a WHERE that matches every row in the table.
    expect(await store.search(agentId, 'what is that')).toEqual([]);
  });

  it('honours the limit', async () => {
    expect(await store.search(agentId, 'chemistry', 1)).toHaveLength(1);
  });

  it("never returns another agent's memories", async () => {
    const other = `search-test-${randomUUID()}`;
    await db.insert(user).values({
      id: other,
      name: 'Other',
      email: `${other}@example.test`,
      emailVerified: true,
    });
    const [otherAgent] = await db
      .insert(agents)
      .values({ userId: other, name: 'other', purpose: 'testing' })
      .returning();
    await db.insert(agentMemories).values({
      agentId: otherAgent!.id,
      kind: 'conversation',
      source: 'agent_run',
      content: 'Student: my chemistry teacher is Ms Secret\nAgent: Noted.',
    });

    const hits = await store.search(agentId, 'chemistry teacher');
    expect(hits.map((h) => h.content).join(' ')).not.toContain('Secret');

    await db.delete(user).where(eq(user.id, other));
  });
});
