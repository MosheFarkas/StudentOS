import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, agents, agentMemories, user, type Database } from '@contexto/db';
import { inArray } from 'drizzle-orm';
import { PostgresProfileStore } from './profile-store.js';

/**
 * The queries behind the profile, against a real database.
 *
 * `stale` is the one that matters. It decides which agents cost a model call
 * on every wake of the job, so a query that is subtly too generous is a bill
 * rather than a bug, and nothing downstream would notice.
 */

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://studentos:studentos@localhost:5432/contexto_test';

const MINUTE = 60_000;

describe('PostgresProfileStore', () => {
  let db: Database;
  let store: PostgresProfileStore;
  const created: string[] = [];

  beforeAll(() => {
    db = createDatabase({ url: DATABASE_URL, maxConnections: 2 });
    store = new PostgresProfileStore(db);
  });

  afterEach(async () => {
    if (created.length > 0) await db.delete(user).where(inArray(user.id, created.splice(0)));
  });

  /** An agent with the given memory ages, in minutes. */
  async function agentWith(memoryAgesMinutes: number[]): Promise<string> {
    const userId = `profile-test-${randomUUID()}`;
    created.push(userId);
    await db.insert(user).values({
      id: userId,
      name: 'Profile Test',
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    const [agent] = await db
      .insert(agents)
      .values({ userId, name: 'profile-test', purpose: 'testing' })
      .returning();

    for (const minutes of memoryAgesMinutes) {
      await db.insert(agentMemories).values({
        agentId: agent!.id,
        kind: 'conversation',
        source: 'agent_run',
        content: 'Student: something\nAgent: Noted.',
        occurredAt: new Date(Date.now() - minutes * MINUTE),
      });
    }
    return agent!.id;
  }

  const staleIds = async (quietFor = 0) =>
    (await store.stale(50, quietFor)).map((row) => row.agentId);

  it('round-trips a profile and its watermark', async () => {
    const agentId = await agentWith([60]);
    const at = new Date();

    await store.save(agentId, 'Takes chemistry.', at);
    const read = await store.read(agentId);

    expect(read?.profile).toBe('Takes chemistry.');
    expect(read?.updatedAt?.getTime()).toBeCloseTo(at.getTime(), -2);
  });

  it('reads an empty profile for an agent that has never had one', async () => {
    const agentId = await agentWith([60]);
    expect(await store.read(agentId)).toEqual({ profile: '', updatedAt: null });
  });

  it('lists an agent that has never been considered', async () => {
    const agentId = await agentWith([60]);
    expect(await staleIds()).toContain(agentId);
  });

  it('stops listing an agent once its watermark passes its memory', async () => {
    // The production bug this guards: an agent the writer decided nothing
    // about stayed stale for ever and was re-read on every wake.
    const agentId = await agentWith([60]);
    await store.save(agentId, '', new Date());
    expect(await staleIds()).not.toContain(agentId);
  });

  it('lists it again when a newer exchange arrives', async () => {
    const agentId = await agentWith([60]);
    await store.save(agentId, 'Takes chemistry.', new Date(Date.now() - 30 * MINUTE));
    await db.insert(agentMemories).values({
      agentId,
      kind: 'conversation',
      source: 'agent_run',
      content: 'Student: newer\nAgent: Noted.',
      occurredAt: new Date(),
    });
    expect(await staleIds()).toContain(agentId);
  });

  it('leaves an agent alone while its conversation is still going', async () => {
    /*
     * The profile sits in the cached part of the system prompt. Rewriting it
     * between one turn and the next invalidates that prefix for the rest of
     * the conversation -- so the job waits for quiet, which is the same reason
     * Hermes freezes its snapshot for the length of a session.
     */
    const talkingNow = await agentWith([1]);
    const finishedEarlier = await agentWith([45]);

    const ids = await staleIds(15 * MINUTE);

    expect(ids).not.toContain(talkingNow);
    expect(ids).toContain(finishedEarlier);
  });

  it('never lists an agent with no memories at all', async () => {
    expect(await staleIds()).not.toContain(await agentWith([]));
  });
});
