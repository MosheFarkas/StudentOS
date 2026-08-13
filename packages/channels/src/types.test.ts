import { describe, expect, it } from 'vitest';
import { parseCommand } from './types.js';

describe('parseCommand', () => {
  it('recognises /start', () => {
    expect(parseCommand('/start')).toBe('start');
    expect(parseCommand('  /start  ')).toBe('start');
    // Telegram appends the bot name in groups and deep-link payloads.
    expect(parseCommand('/start@contexto_bot')).toBe('start');
  });

  it('extracts a link code', () => {
    expect(parseCommand('/link ABC123')).toEqual({ code: 'ABC123' });
  });

  it('uppercases the code so case cannot cause a false rejection', () => {
    // Phone keyboards autocapitalise inconsistently; codes are stored upper.
    expect(parseCommand('/link abc123')).toEqual({ code: 'ABC123' });
    expect(parseCommand('/link AbC123')).toEqual({ code: 'ABC123' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseCommand('  /link ABC123  ')).toEqual({ code: 'ABC123' });
    expect(parseCommand('/link   ABC123')).toEqual({ code: 'ABC123' });
  });

  it('returns null for ordinary messages', () => {
    // Everything here reaches the agent when linked, and is ignored when not.
    expect(parseCommand('what is due tomorrow?')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('link ABC123')).toBeNull();
  });

  it('returns null for a /link with no code', () => {
    expect(parseCommand('/link')).toBeNull();
    expect(parseCommand('/link ')).toBeNull();
    // Too short to be one of ours -- do not hand junk to the redeemer.
    expect(parseCommand('/link AB')).toBeNull();
  });

  it('does not treat unrelated slash commands as commands', () => {
    expect(parseCommand('/help')).toBeNull();
    expect(parseCommand('/linked ABC123')).toBeNull();
  });
});
