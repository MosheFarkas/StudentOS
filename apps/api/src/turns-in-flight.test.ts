import { beforeEach, describe, expect, it } from 'vitest';
import { beginTurn, endTurn, resetTurns, turnRunning } from './turns-in-flight.js';

const A = 'agent-a';
const B = 'agent-b';

beforeEach(() => resetTurns());

describe('turns in flight', () => {
  it('knows nothing is running to begin with', () => {
    expect(turnRunning(A)).toBe(false);
  });

  it('reports a turn while it runs, and not after', () => {
    beginTurn(A);
    expect(turnRunning(A)).toBe(true);
    endTurn(A);
    expect(turnRunning(A)).toBe(false);
  });

  it('keeps one conversation out of another', () => {
    beginTurn(A);
    expect(turnRunning(B)).toBe(false);
  });

  it('stays running until the last of two overlapping turns finishes', () => {
    // The same student answered in the app and over Telegram at once. The
    // first to finish must not declare the conversation idle.
    beginTurn(A);
    beginTurn(A);
    endTurn(A);
    expect(turnRunning(A)).toBe(true);
    endTurn(A);
    expect(turnRunning(A)).toBe(false);
  });

  it('does not go negative when something ends twice', () => {
    // A crash path could unwind more than once; that must not leave a
    // conversation permanently unable to report a turn again.
    beginTurn(A);
    endTurn(A);
    endTurn(A);
    expect(turnRunning(A)).toBe(false);
    beginTurn(A);
    expect(turnRunning(A)).toBe(true);
  });
});
