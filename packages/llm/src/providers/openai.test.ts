import { describe, expect, it, vi } from 'vitest';
import { OpenAiProvider, toResponsesInput, toolsFor } from './openai.js';
import type { ChatMessage } from '../types.js';

// The SDK is the boundary: capture what chat() hands it instead of dialling out.
const create = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));

/**
 * The Responses API request shape.
 *
 * Worth testing directly because getting it wrong produces a 400 that only
 * surfaces once a tool is registered -- which is exactly the corner that
 * shipped broken twice.
 */
describe('toResponsesInput', () => {
  it('lifts system messages into instructions', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);

    // Responses takes the system prompt top-level, not as an input item.
    expect(instructions).toBe('You are helpful.');
    expect(input).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('joins multiple system messages', () => {
    const { instructions } = toResponsesInput([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'hi' },
    ]);
    expect(instructions).toBe('A\n\nB');
  });

  it('omits instructions entirely when there is no system message', () => {
    expect(toResponsesInput([{ role: 'user', content: 'hi' }]).instructions).toBeUndefined();
  });

  /**
   * The multi-turn tool bug. A function_call_output whose matching
   * function_call was never replayed refers to nothing, and the API rejects
   * the whole request.
   */
  it('replays tool calls before their results', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'what is on my calendar?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [
          { id: 'call_abc', name: 'google_calendar_list_events', arguments: '{"startIso":"x"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_abc', content: '{"events":[]}' },
    ];

    expect(toResponsesInput(messages).input).toEqual([
      { role: 'user', content: 'what is on my calendar?' },
      { role: 'assistant', content: 'Let me check.' },
      {
        type: 'function_call',
        call_id: 'call_abc',
        name: 'google_calendar_list_events',
        arguments: '{"startIso":"x"}',
      },
      { type: 'function_call_output', call_id: 'call_abc', output: '{"events":[]}' },
    ]);
  });

  it('emits the call even when the assistant said nothing alongside it', () => {
    // Models frequently call a tool with no preamble. An empty text item would
    // be rejected, so it must be skipped rather than sent blank.
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'tool_a', arguments: '{}' }],
      },
    ]);

    expect(input).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'tool_a', arguments: '{}' },
    ]);
  });

  it('handles several tool calls in one turn', () => {
    const { input } = toResponsesInput([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'tool_a', arguments: '{}' },
          { id: 'c2', name: 'tool_b', arguments: '{"x":1}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: 'a' },
      { role: 'tool', toolCallId: 'c2', content: 'b' },
    ]);

    expect(input).toHaveLength(4);
    expect(input.filter((i) => 'type' in i && i.type === 'function_call')).toHaveLength(2);
  });

  it('keeps a plain assistant turn as a message', () => {
    const { input } = toResponsesInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ]);

    expect(input).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ]);
  });
});

describe('the tools OpenAI receives', () => {
  const request = (over = {}) => ({
    messages: [{ role: 'user' as const, content: 'hi' }],
    ...over,
  });

  it('sends nothing when there is nothing to send', () => {
    expect(toolsFor(request())).toBeUndefined();
  });

  it('does not offer web search unless it is asked for', () => {
    const tools = toolsFor(
      request({ tools: [{ name: 'vault_open', description: 'Open a page', parameters: {} }] }),
    );

    expect(tools?.map((tool) => tool.type)).toEqual(['function']);
  });

  it('adds the provider’s own search when a pass asks to research', () => {
    expect(toolsFor(request({ webSearch: {} }))).toEqual([{ type: 'web_search' }]);
  });

  it('keeps the caller’s own tools alongside it', () => {
    const tools = toolsFor(
      request({
        tools: [{ name: 'vault_open', description: 'Open a page', parameters: {} }],
        webSearch: {},
      }),
    );

    expect(tools?.map((tool) => tool.type)).toEqual(['function', 'web_search']);
  });
});

describe('the reasoning OpenAI is asked for', () => {
  it('runs every turn at xhigh effort', async () => {
    create.mockResolvedValueOnce({ output: [], output_text: '', status: 'completed' });
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'gpt-5.6-luna' });

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] }, { userId: 'u1' });

    expect(create.mock.calls[0]?.[0]).toMatchObject({ reasoning: { effort: 'xhigh' } });
  });
});
