import { describe, expect, it, vi } from 'vitest';
import { updateStudentProfile } from './summarize.js';
import type { EpisodicMemory, MemoryStore } from './types.js';
import type { ProfileStore } from './profile.js';

/**
 * The job that decides what is worth keeping.
 *
 * It runs between conversations and rewrites one bounded document. The
 * failures that matter are quiet ones: spending a model call on a
 * conversation that taught it nothing, or letting the document grow past the
 * budget it is supposed to enforce -- both of which cost on every turn of
 * every conversation afterwards, where nothing would point back here.
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
  const saved: { profile: string }[] = [];
  const store: ProfileStore = {
    read: async () => ({ profile: current, updatedAt }),
    save: async (_agentId, profile) => {
      saved.push({ profile });
    },
    stale: async () => [],
  };
  return { store, saved };
}

const llmReturning = (content: string) => ({
  chat: vi.fn(async () => ({
    content,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop' as const,
  })),
});

const run = (deps: { llm: unknown; memory: MemoryStore; profiles: ProfileStore }) =>
  updateStudentProfile(deps as never, { agentId: 'a1', userId: 'u1' });

describe('updating the profile', () => {
  it('writes what the model returns', async () => {
    const { store, saved } = profileStore('', null);
    const llm = llmReturning('Takes chemistry and history. Revises by rewriting notes.');

    await run({
      llm,
      memory: memoryWith([
        { content: 'Student: i revise by rewriting\nAgent: Noted.', hoursAgo: 1 },
      ]),
      profiles: store,
    });

    expect(saved[0]?.profile).toBe('Takes chemistry and history. Revises by rewriting notes.');
  });

  it('shows the model the document it is rewriting', async () => {
    const { store } = profileStore('Takes chemistry.', at(48));
    const llm = llmReturning('Takes chemistry and history.');

    await run({
      llm,
      memory: memoryWith([{ content: 'Student: i also do history\nAgent: Noted.', hoursAgo: 1 }]),
      profiles: store,
    });

    const sent = JSON.stringify(llm.chat.mock.calls[0]);
    expect(sent).toContain('Takes chemistry.');
    expect(sent).toContain('i also do history');
  });

  it('spends nothing on a conversation with no new exchanges', async () => {
    // The common case by a wide margin. A model call per run regardless of
    // whether anything happened is a bill that scales with uptime.
    const { store, saved } = profileStore('Takes chemistry.', at(1));
    const llm = llmReturning('anything');

    const result = await run({
      llm,
      memory: memoryWith([{ content: 'Student: old\nAgent: Noted.', hoursAgo: 48 }]),
      profiles: store,
    });

    expect(llm.chat).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(result.changed).toBe(false);
  });

  it('reports no change when the model returns the document untouched', async () => {
    const { store, saved } = profileStore('Takes chemistry.', at(48));
    const llm = llmReturning('Takes chemistry.');

    const result = await run({
      llm,
      memory: memoryWith([{ content: 'Student: whats 2+2\nAgent: 4.', hoursAgo: 1 }]),
      profiles: store,
    });

    expect(result.changed).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('holds an over-long rewrite to the budget before saving it', async () => {
    // The cap cannot live only in the prompt. A model that ignores it would
    // otherwise put an unbounded document into the cached prefix.
    const { store, saved } = profileStore('', null);
    const llm = llmReturning('This student does a thing. '.repeat(200));

    await run({
      llm,
      memory: memoryWith([{ content: 'Student: hi\nAgent: Hello.', hoursAgo: 1 }]),
      profiles: store,
    });

    expect(saved[0]?.profile.length).toBeLessThanOrEqual(1400);
  });

  it('keeps the old profile when the model returns nothing usable', async () => {
    // An empty completion must not wipe what the agent already knew.
    const { store, saved } = profileStore('Takes chemistry.', at(48));
    const llm = llmReturning('   ');

    const result = await run({
      llm,
      memory: memoryWith([{ content: 'Student: hi\nAgent: Hello.', hoursAgo: 1 }]),
      profiles: store,
    });

    expect(saved).toHaveLength(0);
    expect(result.changed).toBe(false);
  });
});
