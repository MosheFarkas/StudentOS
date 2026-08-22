import { beforeEach, describe, expect, it } from 'vitest';
import { runTurnForAgent } from './agent-turn.js';
import { resetTurns, turnActivity, turnRunning } from './turns-in-flight.js';
import { createAgent, createUser, reset, testDb } from './test-support/harness.js';
import type { AppContext } from './context.js';

/**
 * The seam between a running turn and what the conversation is told about it.
 *
 * The bug this exists for is the one the agent package has already been bitten
 * by: an input accepted at the bottom of the stack that nothing at the top ever
 * passes. `runAgentTurn` reports every step it takes and has tests proving it;
 * none of that reaches a student unless this file hands it somewhere the poll
 * can read. Tested from inside the turn, because the moment the seam describes
 * only exists while the turn is running -- afterwards it is deliberately gone.
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * Enough context to run a turn. Everything a turn touches that is not the
 * database is stubbed; the database is real, because both messages the turn
 * writes are rows and the harness already has one.
 */
async function contextWith(chat: () => Promise<unknown>): Promise<AppContext> {
  return {
    db: await testDb(),
    llm: { chat },
    memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
    skills: { list: async () => [] },
    auth: {},
    youtube: {},
    youtubeTranscripts: {},
  } as unknown as AppContext;
}

beforeEach(async () => {
  await reset();
  resetTurns();
});

describe('reporting what a turn is doing', () => {
  it('says it is thinking while it waits on the model', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    let seen: unknown;
    const ctx = await contextWith(async () => {
      seen = turnActivity(agent.id);
      return { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
    });

    await runTurnForAgent(ctx, { userId: alice.id, agent, content: 'hello' });

    expect(seen).toEqual({ kind: 'thinking' });
  });

  it('files it under the conversation that asked, and no other', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);
    const other = await createAgent(alice.id);

    let seen: unknown = 'unset';
    const ctx = await contextWith(async () => {
      seen = turnActivity(other.id);
      return { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
    });

    await runTurnForAgent(ctx, { userId: alice.id, agent, content: 'hello' });

    expect(seen).toBeUndefined();
  });

  it('has nothing left to say once the turn is over', async () => {
    // A finished answer with a line under it still claiming to be thinking is
    // worse than no line at all: it says the app has lost track.
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const ctx = await contextWith(async () => ({
      content: 'done',
      toolCalls: [],
      usage,
      finishReason: 'stop' as const,
    }));

    await runTurnForAgent(ctx, { userId: alice.id, agent, content: 'hello' });

    expect(turnRunning(agent.id)).toBe(false);
    expect(turnActivity(agent.id)).toBeUndefined();
  });

  it('stops reporting when the turn throws, rather than freezing on a step', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const ctx = await contextWith(async () => {
      throw new Error('the model fell over');
    });

    await expect(
      runTurnForAgent(ctx, { userId: alice.id, agent, content: 'hello' }),
    ).rejects.toThrow();
    expect(turnActivity(agent.id)).toBeUndefined();
  });
});
