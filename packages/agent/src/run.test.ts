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

/**
 * A model that returns no text field at all.
 *
 * Not hypothetical: the OpenAI adapter passes `output_text` straight through,
 * and a response carrying no text has no such field. That is the very case
 * the fallback above exists for -- so reaching it must not be what breaks.
 * Calling .trim() on it threw a TypeError, which took the whole turn down and
 * left the student with nothing at all rather than with the fallback.
 */
describe('a reply with no text field', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const input = { userId: 'u1', agentId: 'a1', purpose: 'test', message: 'go' } as never;
  const deps = (chat: () => Promise<unknown>) =>
    ({
      llm: { chat },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools: new ToolRegistry(),
    }) as unknown as AgentRunDeps;

  it('does not throw when content is missing entirely', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({ toolCalls: [], usage, finishReason: 'stop' as const })),
      input,
    );
    expect(reply.trim()).not.toBe('');
  });

  it('does not throw when content is null', async () => {
    const { reply } = await runAgentTurn(
      deps(async () => ({ content: null, toolCalls: [], usage, finishReason: 'stop' as const })),
      input,
    );
    expect(reply.trim()).not.toBe('');
  });
});

/**
 * Saying what it is doing, while it does it.
 *
 * A turn that calls tools can run for a minute, and until now the only thing
 * the student could be told was that something was happening. The loop knows
 * far more than that -- which tool it is about to run, and when it has gone
 * back to the model -- and reporting it is what lets the conversation name the
 * work instead of spinning.
 *
 * A notification, not a hook: whatever the caller does with it, the turn runs
 * exactly as it would have.
 */
describe('reporting activity', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

  function depsCalling(toolIds: string[]) {
    const tools = new ToolRegistry();
    for (const id of toolIds) {
      tools.register({
        id,
        description: 'a tool',
        inputSchema: z.object({}),
        execute: async () => 'ok',
      } as never);
    }
    let turn = 0;
    return {
      llm: {
        async chat() {
          turn += 1;
          return turn === 1
            ? {
                content: '',
                toolCalls: toolIds.map((name, i) => ({ id: `c${i}`, name, arguments: '{}' })),
                usage,
                finishReason: 'tool_calls' as const,
              }
            : { content: 'done', toolCalls: [], usage, finishReason: 'stop' as const };
        },
      },
      memory: { recall: async () => ({ summaries: [], recent: [] }), record: async () => ({}) },
      skills: { list: async () => [] },
      tools,
    } as unknown as AgentRunDeps;
  }

  const input = (onActivity: unknown) =>
    ({ userId: 'u1', agentId: 'a1', purpose: 'test', message: 'go', onActivity }) as never;

  it('says it is thinking before it asks the model', async () => {
    const seen: unknown[] = [];
    await runAgentTurn(
      depsCalling([]),
      input((a: unknown) => seen.push(a)),
    );

    expect(seen[0]).toEqual({ kind: 'thinking' });
  });

  it('names each tool before running it', async () => {
    const seen: unknown[] = [];
    await runAgentTurn(
      depsCalling(['google_calendar_list']),
      input((a: unknown) => seen.push(a)),
    );

    expect(seen).toContainEqual({ kind: 'tool', name: 'google_calendar_list' });
  });

  it('reports tools in the order the model asked for them', async () => {
    const seen: string[] = [];
    await runAgentTurn(
      depsCalling(['gmail_search', 'google_drive_list']),
      input((a: { kind: string; name?: string }) => {
        if (a.kind === 'tool' && a.name) seen.push(a.name);
      }),
    );

    expect(seen).toEqual(['gmail_search', 'google_drive_list']);
  });

  it('goes back to thinking after the tools have run', async () => {
    // The student watched it read their mail; what follows is the model
    // working out what to say about it, and saying so is the honest report.
    const seen: string[] = [];
    await runAgentTurn(
      depsCalling(['gmail_search']),
      input((a: { kind: string }) => seen.push(a.kind)),
    );

    expect(seen).toEqual(['thinking', 'tool', 'thinking']);
  });

  it('runs the turn normally when nobody is listening', async () => {
    const { reply } = await runAgentTurn(depsCalling(['gmail_search']), input(undefined));
    expect(reply).toBe('done');
  });
});
