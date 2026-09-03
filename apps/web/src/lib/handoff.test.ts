import { describe, expect, it } from 'vitest';
import { handOff, takeHandoff } from './handoff.js';

describe('carrying the first message into a new chat', () => {
  it('hands the message to the chat it was left for', () => {
    handOff('a1', 'what is due friday');
    expect(takeHandoff('a1')).toBe('what is due friday');
  });

  it('gives it up only once', () => {
    // The effect that consumes it can run more than once. A second send of
    // the same message is the failure this prevents.
    handOff('a1', 'hello');
    expect(takeHandoff('a1')).toBe('hello');
    expect(takeHandoff('a1')).toBeUndefined();
  });

  it('does not hand one chat the message meant for another', () => {
    handOff('a1', 'for the first chat');
    expect(takeHandoff('a2')).toBeUndefined();
    // Still waiting for the one it was actually addressed to.
    expect(takeHandoff('a1')).toBe('for the first chat');
  });

  it('has nothing to give when nothing was left', () => {
    expect(takeHandoff('never-set')).toBeUndefined();
  });

  it('keeps only the most recent, so an abandoned start cannot resurface', () => {
    handOff('a1', 'first');
    handOff('a2', 'second');
    expect(takeHandoff('a1')).toBeUndefined();
    expect(takeHandoff('a2')).toBe('second');
  });
});
