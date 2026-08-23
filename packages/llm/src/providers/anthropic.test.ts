import { describe, expect, it } from 'vitest';
import { splitSystem } from './anthropic.js';

/**
 * The cache breakpoint.
 *
 * Anthropic caches nothing unless a request asks it to, and a request that
 * forgets still succeeds -- same answer, full price, `cache_read_input_tokens`
 * reporting zero for the rest of time. Nothing else in this codebase would
 * notice, which is why it went unnoticed until the prompt was audited.
 */
describe('the system prompt Anthropic receives', () => {
  const system = (parts: string[]) =>
    splitSystem([
      ...parts.map((content) => ({ role: 'system' as const, content })),
      { role: 'user' as const, content: 'hi' },
    ]).system;

  it('asks for the system prompt to be cached', () => {
    const blocks = system(['You are helpful.']);
    expect(blocks?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('carries the prompt as a text block', () => {
    const blocks = system(['You are helpful.']);
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.type).toBe('text');
    expect(blocks?.[0]?.text).toBe('You are helpful.');
  });

  it('joins several system messages into one cached block', () => {
    // One breakpoint covering the whole prompt, not one per section: Anthropic
    // allows only a handful, and the prompt is assembled as a single string
    // upstream anyway.
    const blocks = system(['A', 'B']);
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.text).toBe('A\n\nB');
  });

  it('sends nothing at all when there is no system message', () => {
    // An empty block array is not the same as omitting the field, and
    // Anthropic rejects a text block with no text.
    expect(splitSystem([{ role: 'user', content: 'hi' }]).system).toBeUndefined();
  });

  it('leaves the conversation itself alone', () => {
    const { messages } = splitSystem([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
