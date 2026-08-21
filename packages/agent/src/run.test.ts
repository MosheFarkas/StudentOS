import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { currentTimeSection, runAgentTurn } from './run.js';
import { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type { AgentRunDeps } from './run.js';

/**
 * Temporal grounding.
 *
 * A model has no clock. Without this the agent cannot turn "tomorrow at 3pm"
 * into an ISO timestamp, so it interrogates the student instead of acting --
 * which is what it did on the first live write attempt.
 */
describe('currentTimeSection', () => {
  const noon = new Date('2026-08-14T16:00:00Z');

  it('states the local time and the offset', () => {
    const section = currentTimeSection('America/New_York', noon);

    expect(section).toContain('America/New_York');
    // 16:00 UTC is 12:00 EDT.
    expect(section).toContain('12:00');
    // The offset is what makes a valid ISO string possible; a zone name alone
    // is not enough, and it shifts with daylight saving.
    expect(section).toContain('GMT-04:00');
  });

  it('reflects daylight saving rather than a fixed offset', () => {
    const winter = new Date('2026-01-14T16:00:00Z');
    expect(currentTimeSection('America/New_York', winter)).toContain('GMT-05:00');
    expect(currentTimeSection('America/New_York', noon)).toContain('GMT-04:00');
  });

  it('falls back to UTC when no timezone is known', () => {
    const section = currentTimeSection(undefined, noon);
    expect(section).toContain('UTC');
  });

  it('tells the agent not to ask', () => {
    // The behaviour being fixed: the agent asked "what timezone?" instead of
    // creating the event.
    expect(currentTimeSection('Europe/London', noon)).toMatch(/do not ask/i);
  });

  it('survives a bogus timezone instead of throwing', () => {
    // A bad value must not take down every turn for that student.
    const section = currentTimeSection('Not/AZone', noon);
    expect(section).toContain('UTC');
    expect(section).toContain('2026-08-14');
  });

  it('gets the date right across a day boundary', () => {
    // 23:30 UTC is already the next day in Tokyo. Getting this wrong schedules
    // everything a day off.
    const lateUtc = new Date('2026-08-14T23:30:00Z');
    expect(currentTimeSection('Asia/Tokyo', lateUtc)).toContain('15 August 2026');
    expect(currentTimeSection('UTC', lateUtc)).toContain('14 August 2026');
  });
});

/**
 * Capability plumbing.
 *
 * The regression this exists for: AgentRunInput accepted a transcriber and
 * runAgentTurn never forwarded it, so every video reported "transcription
 * isn't configured" on a server where it was. The seam existed and stopped
 * one layer short -- invisible to every other test, because they exercise the
 * tools directly and build the context themselves.
 */
describe('tool context', () => {
  /** Answers one tool call, then replies. Enough to reach a tool. */
  function llmCallingProbe() {
    let turn = 0;
    return {
      async chat() {
        turn += 1;
        const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
        return turn === 1
          ? {
              content: '',
              toolCalls: [{ id: 'c1', name: 'probe', arguments: '{}' }],
              usage,
              finishReason: 'tool_calls' as const,
            }
          : { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
      },
    };
  }

  it('forwards every optional capability to the tool', async () => {
    const seen: ToolContext[] = [];
    const tools = new ToolRegistry();
    tools.register({
      id: 'probe',
      description: 'records the context it receives',
      inputSchema: z.object({}),
      execute: async (_input: Record<string, never>, ctx: ToolContext) => {
        seen.push(ctx);
        return 'ok';
      },
    } as never);

    const google = { getAccessToken: async () => 'token', hasScope: () => true };
    const transcriber = { transcribe: async () => 'words' };

    const deps = {
      llm: llmCallingProbe(),
      memory: {
        recall: async () => ({ summaries: [], recent: [] }),
        record: async () => ({}),
      },
      skills: { list: async () => [] },
      tools,
    } as unknown as AgentRunDeps;

    await runAgentTurn(deps, {
      userId: 'u1',
      agentId: 'a1',
      purpose: 'test',
      message: 'go',
      google,
      transcriber,
    } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.google).toBe(google);
    expect(seen[0]?.transcriber).toBe(transcriber);
  });
});

/**
 * A turn always says something.
 *
 * A model that does its work and then returns no text leaves an empty bubble
 * in the conversation -- the browser visibly went and read a page, and the
 * student is told nothing at all about what it found. Whatever else happens,
 * a turn owes the student a sentence.
 */
describe('always answering', () => {
  const deps = (chat: () => Promise<unknown>) =>
    ({
      llm: { chat },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools: new ToolRegistry(),
    }) as unknown as AgentRunDeps;

  const input = { userId: 'u1', agentId: 'a1', purpose: 'test', message: 'go' } as never;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

  it('says something even when the model returns nothing at all', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({ content: '', toolCalls: [], usage, finishReason: 'stop' as const })),
      input,
    );
    expect(reply.trim()).not.toBe('');
  });

  it('says something when the model returns only whitespace', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({
        content: '   \n  ',
        toolCalls: [],
        usage,
        finishReason: 'stop' as const,
      })),
      input,
    );
    expect(reply.trim()).not.toBe('');
  });

  it('leaves a real answer exactly as the model wrote it', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({
        content: 'Dogs live 10-13 years.',
        toolCalls: [],
        usage,
        finishReason: 'stop' as const,
      })),
      input,
    );
    expect(reply).toBe('Dogs live 10-13 years.');
  });

  it('mentions what it did when it has nothing else to say', async () => {
    // It drove a browser and then went quiet: the fallback should at least
    // account for the work the student watched happen.
    const tools = new ToolRegistry();
    tools.register({
      id: 'browser_open',
      description: 'opens a page',
      inputSchema: z.object({}),
      execute: async () => 'page text',
    } as never);

    let turn = 0;
    const chat = async () => {
      turn += 1;
      return turn === 1
        ? {
            content: '',
            toolCalls: [{ id: 'c1', name: 'browser_open', arguments: '{}' }],
            usage,
            finishReason: 'tool_calls' as const,
          }
        : { content: '', toolCalls: [], usage, finishReason: 'stop' as const };
    };

    const runDeps = {
      llm: { chat },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools,
    } as unknown as AgentRunDeps;

    const { reply } = await runAgentTurn(runDeps, input);
    expect(reply).toMatch(/browser_open/);
  });
});
