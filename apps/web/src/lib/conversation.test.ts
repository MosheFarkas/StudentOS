import { describe, expect, it } from 'vitest';
import type { Message } from '@contexto/shared';
import { sameConversation } from './conversation.js';

const msg = (id: string, content = 'hi'): Message => ({
  id,
  agentId: 'a1',
  role: 'user',
  content,
  toolsUsed: [],
  createdAt: '2026-08-21T00:00:00.000Z',
});

describe('sameConversation', () => {
  it('sees no change when nothing was said', () => {
    // The common case by far: this runs every few seconds, and saying "no
    // change" is what stops the conversation redrawing under the student.
    expect(sameConversation([msg('1'), msg('2')], [msg('1'), msg('2')])).toBe(true);
  });

  it('notices a new message', () => {
    expect(sameConversation([msg('1')], [msg('1'), msg('2')])).toBe(false);
  });

  it('notices the reply that turned up on the other screen', () => {
    // Sent from the app, answered there, and this is the website catching up.
    const before = [msg('1')];
    const after = [msg('1'), msg('2')];
    expect(sameConversation(before, after)).toBe(false);
  });

  it('treats two empty conversations as the same', () => {
    expect(sameConversation([], [])).toBe(true);
  });

  it('notices the first message in an empty conversation', () => {
    expect(sameConversation([], [msg('1')])).toBe(false);
  });

  it('notices a swap that keeps the count the same', () => {
    // A deletion plus an arrival lands on the same length; the last id is
    // what still separates them.
    expect(sameConversation([msg('1'), msg('2')], [msg('1'), msg('3')])).toBe(false);
  });
});
