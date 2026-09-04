import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { currentTimeSection, runAgentTurn } from './run.js';
import { RESPONDING } from './prompts/documents.js';
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

/**
 * The prompt documents actually reach the model.
 *
 * buildSystemPrompt is private, so nothing outside this file would notice a
 * section being dropped from it. The document could be perfect, tested, and
 * never sent.
 */
describe('the assembled system prompt', () => {
  /** Records the messages the turn sends, then replies. */
  function capturing(seen: { role: string; content: string }[], recent: Recalled = []) {
    return {
      llm: {
        async chat({ messages }: { messages: { role: string; content: string }[] }) {
          seen.push(...messages);
          return {
            content: 'done',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: 'stop' as const,
          };
        },
      },
      memory: {
        recall: async () => ({ summaries: [], recent }),
        record: async () => ({}),
      },
      skills: { list: async () => [] },
      tools: new ToolRegistry(),
    } as unknown as AgentRunDeps;
  }

  type Recalled = { kind: string; content: string }[];

  async function messagesFor(
    recent: Recalled,
    about?: string,
  ): Promise<{ role: string; content: string }[]> {
    const seen: { role: string; content: string }[] = [];
    await runAgentTurn(capturing(seen, recent), {
      userId: 'u1',
      agentId: 'a1',
      purpose: 'keep me on top of chemistry',
      message: 'go',
      timezone: 'Europe/London',
      ...(about === undefined ? {} : { about }),
    } as never);
    return seen;
  }

  async function systemPrompt(recent: Recalled = [], about?: string): Promise<string> {
    return (await messagesFor(recent, about)).find((m) => m.role === 'system')?.content ?? '';
  }

  async function userMessage(recent: Recalled = []): Promise<string> {
    return (await messagesFor(recent)).find((m) => m.role === 'user')?.content ?? '';
  }

  it('carries the responding document', async () => {
    expect(await systemPrompt()).toContain(RESPONDING.body);
  });

  /** The same prompt, for an agent created with the given purpose. */
  async function promptForPurpose(purpose: string): Promise<string> {
    const seen: { role: string; content: string }[] = [];
    await runAgentTurn(capturing(seen), {
      userId: 'u1',
      agentId: 'a1',
      purpose,
      message: 'go',
      timezone: 'Europe/London',
    } as never);
    return seen.find((m) => m.role === 'system')?.content ?? '';
  }

  /**
   * What the student attached reaches the model on the turn they attached it.
   *
   * The bug this pins was the whole image feature failing at its last step: a
   * photograph was read, transcribed and filed in the vault, and then the
   * agent answered "I cannot see images" -- because nothing put the
   * transcription in front of it, and "what is this" gives vault_search
   * nothing to search for.
   */
  async function turnWith(attachments: { name: string; body: string }[]): Promise<string> {
    const seen: { role: string; content: string }[] = [];
    await runAgentTurn(capturing(seen), {
      userId: 'u1',
      agentId: 'a1',
      purpose: 'help',
      message: 'what is this',
      timezone: 'Europe/London',
      attachments,
    } as never);
    return seen.find((m) => m.role === 'user')?.content ?? '';
  }

  it('carries what the student attached, contents and all', async () => {
    const turn = await turnWith([
      { name: 'board', body: '## What is in it\n\nA brass push-fit pneumatic connector.' },
    ]);

    expect(turn).toContain('brass push-fit pneumatic connector');
    expect(turn).toContain('board');
  });

  it('says nothing about attachments when there are none', async () => {
    expect(await turnWith([])).not.toContain('attached to this message');
  });

  it('keeps them in the turn rather than the system prompt', async () => {
    // The system prompt has to stay byte-identical between turns or nothing in
    // it caches, ever. A file attached to one message must not land there.
    const seen: { role: string; content: string }[] = [];
    await runAgentTurn(capturing(seen), {
      userId: 'u1',
      agentId: 'a1',
      purpose: 'help',
      message: 'what is this',
      timezone: 'Europe/London',
      attachments: [{ name: 'board', body: 'A connector.' }],
    } as never);

    expect(seen.find((m) => m.role === 'system')?.content ?? '').not.toContain('A connector.');
  });

  it('states the purpose when the student wrote one', async () => {
    expect(await promptForPurpose('keep me on top of chemistry')).toContain(
      'Your purpose, in their words: keep me on top of chemistry',
    );
  });

  /*
   * A chat started from a message has no purpose behind it, and the label
   * printed with nothing after it is worse than its absence: it tells the
   * model an answer belongs here and that it is empty, which reads as a
   * student who wants nothing.
   */
  it('says nothing about purpose when there is none', async () => {
    for (const blank of ['', '   ', '\n']) {
      expect(await promptForPurpose(blank)).not.toContain('Your purpose');
    }
  });

  /*
   * The property the whole prompt layout exists to protect.
   *
   * On the Responses API the system prompt is cached as a whole blob keyed on
   * its exact text -- appending six tokens to a 3,613-token prompt measured
   * `cached_tokens` dropping from 3,610 to zero. So a system prompt containing
   * a clock, or anything else that moves, does not cache partially. It does
   * not cache at all, on any turn, forever.
   *
   * A comment asking future editors to keep volatile text out cannot fail.
   * These can.
   */
  it('keeps the clock and the memory out of the system prompt', async () => {
    const prompt = await systemPrompt();
    expect(prompt).not.toContain('Right now it is');
    expect(prompt).not.toContain('Recently:');
  });

  it('sends a byte-identical system prompt when only the memory has changed', async () => {
    const first = await systemPrompt([{ kind: 'conversation', content: 'Student: a\nAgent: b' }]);
    const second = await systemPrompt([
      { kind: 'conversation', content: 'Student: a\nAgent: b' },
      { kind: 'conversation', content: 'Student: c\nAgent: d' },
    ]);
    expect(second).toBe(first);
  });

  it('still gives the model the clock and the memory, in the turn instead', async () => {
    // Moving them must not lose them: an agent that cannot resolve "tomorrow"
    // is broken in a way no caching win would justify.
    const user = await userMessage([{ kind: 'conversation', content: 'Student: a\nAgent: b' }]);
    expect(user).toContain('Right now it is');
    expect(user).toContain('Their timezone is');
    expect(user).toContain('Recently:');
    expect(user).toContain('Student: a');
  });

  it('marks the context off from what the student actually typed', async () => {
    // It rides in the user message, so without a boundary the model reads the
    // memory dump as something the student wrote.
    const user = await userMessage([]);
    expect(user).toMatch(/<turn_context>[\s\S]*<\/turn_context>/);
    expect(user.indexOf('</turn_context>')).toBeLessThan(user.indexOf('go'));
  });

  it('carries the page the vault writes about the student', async () => {
    const prompt = await systemPrompt([], '# Lucas\n\n- [[class-french]] — taught by Mme Rivard');
    expect(prompt).toContain('[[class-french]]');
    expect(prompt).toMatch(/what their vault says about them/i);
  });

  it('keeps that page above everything volatile, so it stays cached', async () => {
    // It is rewritten between conversations at most, which makes it per-agent
    // rather than per-turn -- the tier that still caches.
    const prompt = await systemPrompt([], '# Lucas');
    expect(prompt.indexOf('# Lucas')).toBeGreaterThan(-1);
    expect(prompt).not.toContain('Right now it is');
  });

  it('carries no heading at all for a student nothing has been written about', async () => {
    // An empty section would cost tokens in the cached prefix on every turn
    // of every conversation, for every new student, forever.
    expect(await systemPrompt([], '')).not.toMatch(/what their vault says about them/i);
  });

  it('no longer carries a second, per-agent document about the same student', async () => {
    /*
     * There used to be two: this page, and a conversation profile belonging to
     * one agent. The split was wrong rather than merely wasteful -- a student
     * with three agents told each of them separately that they read on a phone.
     */
    expect(await systemPrompt([], '# Lucas')).not.toMatch(/what you know about this student/i);
  });

  it('does not still carry the instruction the document replaced', async () => {
    // "Be direct and useful; skip preamble" moved into responding.md. Left in
    // both places it would drift, and the two copies would disagree.
    expect(await systemPrompt()).not.toContain('skip preamble');
  });
});
