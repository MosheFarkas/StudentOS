import { describe, expect, it } from 'vitest';
import { collectExchanges } from './summarize.js';
import type { EpisodicMemory, MemoryStore } from './types.js';
import type { ProfileStore } from './profile.js';

/**
 * The job that gathers up what a student said, once they have stopped saying it.
 *
 * It runs between conversations, and hands what it finds to the one page of
 * what has been learned about them. The failures that matter are quiet ones:
 * re-reading the same exchanges on every wake because the watermark never
 * moved, or handing back a burst that was already written -- both of which cost
 * on a timer, where nothing would point back here.
 */

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);

function memoryWith(contents: { content: string; hoursAgo: number }[]): MemoryStore {
  const entries: EpisodicMemory[] = contents.map((c, i) => ({
    id: `m${i}`,
    agentId: 'a1',
    kind: 'conversation',
    content: c.content,
    source: 'agent_run',
    occurredAt: at(c.hoursAgo),
    createdAt: at(c.hoursAgo),
  }));
  return {
    record: async () => entries[0] as EpisodicMemory,
    recall: async () => ({ summaries: [], recent: entries }),
    search: async () => [],
    unsummarized: async () => [],
    saveSummary: async () => {
      throw new Error('unused');
    },
  };
}

function profileStore(current: string, updatedAt: Date | null) {
  const saved: { profile: string; at: Date }[] = [];
  const store: ProfileStore = {
    read: async () => ({ profile: current, updatedAt }),
    save: async (_agentId, profile, at) => {
      saved.push({ profile, at });
    },
    stale: async () => [],
  };
  return { store, saved };
}

const run = (memory: MemoryStore, profiles: ProfileStore) =>
  collectExchanges({ memory, profiles }, { agentId: 'a1', userId: 'u1' });

describe('handing the conversation on', () => {
  it('returns the exchanges since it was last looked at', async () => {
    const memory = memoryWith([
      { content: 'Student: old\nAgent: older', hoursAgo: 48 },
      { content: 'Student: new\nAgent: newer', hoursAgo: 1 },
    ]);
    const { store } = profileStore('', at(24));

    const result = await run(memory, store);

    expect(result.exchanges).toEqual(['Student: new\nAgent: newer']);
    expect(result.newestId).toBe('m1');
  });

  it('takes everything when nothing has looked yet', async () => {
    const memory = memoryWith([{ content: 'Student: hi\nAgent: hello', hoursAgo: 1 }]);
    const { store } = profileStore('', null);

    expect((await run(memory, store)).exchanges).toHaveLength(1);
  });

  it('returns nothing to record when there were no new exchanges', async () => {
    const memory = memoryWith([{ content: 'Student: old\nAgent: older', hoursAgo: 48 }]);
    const { store } = profileStore('', at(24));

    expect(await run(memory, store)).toEqual({ exchanges: [] });
  });

  it('does not move the watermark when it found nothing', async () => {
    // Otherwise a pass that read nothing would still mark the agent considered.
    const memory = memoryWith([{ content: 'Student: old\nAgent: older', hoursAgo: 48 }]);
    const { store, saved } = profileStore('', at(24));

    await run(memory, store);
    expect(saved).toHaveLength(0);
  });

  it('advances the watermark whenever it did read something', async () => {
    /*
     * It records when this agent was last CONSIDERED, not when anything
     * changed. Leaving it alone on a pass that decided nothing was worth
     * keeping leaves the agent permanently stale, and the job re-reads the same
     * exchanges to reach the same conclusion on every wake. Production had two
     * agents in exactly that state within an hour of the previous version
     * shipping.
     */
    const memory = memoryWith([{ content: 'Student: new\nAgent: newer', hoursAgo: 1 }]);
    const { store, saved } = profileStore('', at(24));

    await run(memory, store);
    expect(saved).toHaveLength(1);
  });

  it('hands on what the agent already knew, once', async () => {
    /*
     * The migration, and there is no SQL in it.
     *
     * Every student has per-agent profiles today. Passing them to the first
     * write of the shared page means nobody loses what was learned about them
     * on the day this ships.
     */
    const memory = memoryWith([{ content: 'Student: new\nAgent: newer', hoursAgo: 1 }]);
    const { store } = profileStore('Lucas prefers worked examples.', at(24));

    expect((await run(memory, store)).knownBefore).toBe('Lucas prefers worked examples.');
  });

  it('hands on nothing when the agent knew nothing', async () => {
    const memory = memoryWith([{ content: 'Student: new\nAgent: newer', hoursAgo: 1 }]);
    const { store } = profileStore('   ', at(24));

    expect((await run(memory, store)).knownBefore).toBeUndefined();
  });

  it('does not overwrite what the agent knew while moving the watermark', async () => {
    const memory = memoryWith([{ content: 'Student: new\nAgent: newer', hoursAgo: 1 }]);
    const { store, saved } = profileStore('Lucas prefers worked examples.', at(24));

    await run(memory, store);
    expect(saved[0]?.profile).toBe('Lucas prefers worked examples.');
  });
});
