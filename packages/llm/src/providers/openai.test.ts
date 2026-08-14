import { describe, expect, it } from 'vitest';
import { toResponsesInput } from './openai.js';
import type { ChatMessage } from '../types.js';

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
