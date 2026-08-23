import { describe, expect, it } from 'vitest';
import { searchMemory } from './memory.js';
import type { ToolContext } from './types.js';
import type { EpisodicMemory, MemoryStore } from '../memory/types.js';

/**
 * The half of memory that is not paid for on every turn.
 *
 * The recency window shrank from twenty exchanges to eight, which is worth
 * about 1,100 tokens a turn and is the only uncached part of the prompt left.
 * That trade is only honest if what falls out of the window is still
 * reachable -- otherwise it is not a saving, it is the agent forgetting.
 */

function entry(content: string): EpisodicMemory {
  const at = new Date('2026-08-01T10:00:00Z');
  return {
    id: 'm1',
    agentId: 'a1',
    kind: 'conversation',
    content,
    source: 'agent_run',
    occurredAt: at,
    createdAt: at,
  };
}

function context(store?: Partial<MemoryStore>): ToolContext {
  return {
    userId: 'u1',
    agentId: 'a1',
    ...(store ? { memory: store as MemoryStore } : {}),
  };
}

describe('memory_search', () => {
  it('returns what it found, with when it happened', async () => {
    const result = await searchMemory.execute(
      { query: 'chemistry' },
      context({ search: async () => [entry('Student: my chem teacher is Mr Ali')] }),
    );

    expect(result).toEqual([
      { when: '2026-08-01T10:00:00.000Z', what: 'Student: my chem teacher is Mr Ali' },
    ]);
  });

  it('passes the agent id through, so one student cannot read another', async () => {
    // The tool takes no agent id from the model on purpose. If it did, a
    // prompt injection in a page the agent read could ask for someone else's.
    let seen: string | undefined;
    await searchMemory.execute(
      { query: 'chemistry' },
      context({
        search: async (agentId) => {
          seen = agentId;
          return [];
        },
      }),
    );
    expect(seen).toBe('a1');
  });

  it('honours the limit, and defaults it when the model omits one', async () => {
    const limits: (number | undefined)[] = [];
    const store = {
      search: async (_a: string, _q: string, limit?: number) => {
        limits.push(limit);
        return [];
      },
    };
    await searchMemory.execute({ query: 'chemistry', limit: 3 }, context(store));
    await searchMemory.execute({ query: 'chemistry' }, context(store));
    expect(limits).toEqual([3, 8]);
  });

  it('says plainly when nothing matched', async () => {
    // Distinguishable from a broken tool, and quotes the term back so the
    // agent can tell the student what it actually looked for.
    const result = await searchMemory.execute(
      { query: 'hockey' },
      context({ search: async () => [] }),
    );
    expect(result).toBe('Nothing in memory matches "hockey".');
  });

  it('reports an unwired deployment rather than looking like an empty history', async () => {
    const result = await searchMemory.execute({ query: 'chemistry' }, context());
    expect(result).toBe('Memory search is not available in this deployment.');
  });

  it('rejects a query too short to mean anything', () => {
    // A one-character ILIKE matches most of the table and returns noise.
    expect(searchMemory.inputSchema.safeParse({ query: 'a' }).success).toBe(false);
    expect(searchMemory.inputSchema.safeParse({ query: 'ali' }).success).toBe(true);
  });

  it('tells the model when to reach for it, not just what it does', async () => {
    // A description that only names the capability gets called for "remember
    // when" and missed for "what did my teacher say" -- the case that needs it.
    expect(searchMemory.description).toMatch(/whenever they refer to something/i);
    expect(searchMemory.description).toMatch(/prefer calling it over telling them you do not/i);
  });

  it("needs no OAuth scope, being the student's own history", () => {
    expect(searchMemory.requiredScopes).toBeUndefined();
  });
});
