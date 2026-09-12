import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginTurn,
  endTurn,
  resetTurns,
  setActivity,
  turnActivity,
  turnRunning,
  turnSkills,
} from './turns-in-flight.js';

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

/**
 * What the running turn is doing.
 *
 * The count above says a turn exists; this says what it is on. It is held
 * beside the count rather than in its own map so the two cannot drift -- an
 * activity outliving the turn it described would have the conversation
 * announcing work that finished minutes ago.
 */
describe('what a turn is doing', () => {
  it('knows nothing about a conversation with no turn', () => {
    expect(turnActivity(A)).toBeUndefined();
  });

  it('reports the last thing it was told', () => {
    beginTurn(A);
    setActivity(A, { kind: 'thinking' });
    expect(turnActivity(A)).toEqual({ kind: 'thinking' });

    setActivity(A, { kind: 'tool', name: 'gmail_search' });
    expect(turnActivity(A)).toEqual({ kind: 'tool', name: 'gmail_search' });
  });

  it('keeps one conversation out of another', () => {
    beginTurn(A);
    beginTurn(B);
    setActivity(A, { kind: 'tool', name: 'gmail_search' });
    expect(turnActivity(B)).toBeUndefined();
  });

  it('forgets it once the turn is over', () => {
    // Otherwise the line under a finished answer still says it is reading
    // mail, which is worse than saying nothing at all.
    beginTurn(A);
    setActivity(A, { kind: 'tool', name: 'gmail_search' });
    endTurn(A);
    expect(turnActivity(A)).toBeUndefined();
  });

  it('keeps reporting while an overlapping turn is still going', () => {
    beginTurn(A);
    beginTurn(A);
    setActivity(A, { kind: 'thinking' });
    endTurn(A);
    expect(turnActivity(A)).toEqual({ kind: 'thinking' });
  });

  it('ignores an activity for a conversation with nothing running', () => {
    // A turn that has already unwound must not be able to plant a label that
    // nothing will ever come along to clear.
    setActivity(A, { kind: 'thinking' });
    expect(turnActivity(A)).toBeUndefined();
    expect(turnRunning(A)).toBe(false);
  });

  it('starts the next turn clean rather than on the last step of the last one', () => {
    beginTurn(A);
    setActivity(A, { kind: 'tool', name: 'gmail_search' });
    endTurn(A);
    beginTurn(A);
    expect(turnActivity(A)).toBeUndefined();
  });
});

/**
 * Which skills the running turn has read.
 *
 * The step above is a moment, and reading a skill is over in milliseconds --
 * a poll every few seconds would never catch it. So the names are kept as a
 * list beside the step, for the conversation to show above the line, and
 * dropped with the turn like everything else here.
 */
describe('what a turn has read', () => {
  it('has read nothing on a conversation with no turn', () => {
    expect(turnSkills(A)).toEqual([]);
  });

  it('keeps every skill the turn reports, in order', () => {
    beginTurn(A);
    setActivity(A, { kind: 'skill', name: 'browser' });
    setActivity(A, { kind: 'thinking' });
    setActivity(A, { kind: 'skill', name: 'vault-reading' });
    expect(turnSkills(A)).toEqual(['browser', 'vault-reading']);
  });

  it('reports reading a skill as the current step too', () => {
    beginTurn(A);
    setActivity(A, { kind: 'skill', name: 'browser' });
    expect(turnActivity(A)).toEqual({ kind: 'skill', name: 'browser' });
  });

  it('names a skill once however often it is reported', () => {
    beginTurn(A);
    setActivity(A, { kind: 'skill', name: 'browser' });
    setActivity(A, { kind: 'skill', name: 'browser' });
    expect(turnSkills(A)).toEqual(['browser']);
  });

  it('keeps one conversation out of another', () => {
    beginTurn(A);
    beginTurn(B);
    setActivity(A, { kind: 'skill', name: 'browser' });
    expect(turnSkills(B)).toEqual([]);
  });

  it('forgets them once the turn is over', () => {
    // The reply carries them from here on; a list that outlived the turn
    // would put the same rows on screen twice.
    beginTurn(A);
    setActivity(A, { kind: 'skill', name: 'browser' });
    endTurn(A);
    expect(turnSkills(A)).toEqual([]);
  });

  it('ignores a skill for a conversation with nothing running', () => {
    setActivity(A, { kind: 'skill', name: 'browser' });
    expect(turnSkills(A)).toEqual([]);
  });
});
