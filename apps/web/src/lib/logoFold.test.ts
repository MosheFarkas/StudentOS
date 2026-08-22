import { describe, expect, it } from 'vitest';
import { CUES, LOOP_SECONDS, REVERSE_AT, authoredTime } from './logoFold.js';

/**
 * The fold's clock.
 *
 * The animation is authored forwards and played back to front to return to a
 * whole logo, so the second half of every loop is the first half read in
 * reverse. Get the mirror wrong by any amount and the mark visibly jumps at
 * the turn -- twice a loop, forever, in the header of every screen.
 */
describe('the fold timeline', () => {
  it('starts each scene where the last one ended', () => {
    expect(CUES['The fold']).toBe(0);
    expect(CUES['Merge']).toBeCloseTo(0.7, 6);
    expect(CUES['Second fold']).toBeCloseTo(0.9, 6);
    expect(CUES['Merge 2']).toBeCloseTo(1.6, 6);
    expect(CUES['Third fold']).toBeCloseTo(1.8, 6);
    expect(CUES['Fourth fold']).toBeCloseTo(2.5, 6);
    expect(CUES['Reverse']).toBeCloseTo(3.2, 6);
  });

  it('runs as long as its scenes do', () => {
    expect(LOOP_SECONDS).toBeCloseTo(6.4, 6);
    expect(REVERSE_AT).toBeCloseTo(CUES['Reverse'] ?? 0, 6);
  });

  it('plays straight through the folding half', () => {
    expect(authoredTime(0)).toBeCloseTo(0, 6);
    expect(authoredTime(1.5)).toBeCloseTo(1.5, 6);
    expect(authoredTime(REVERSE_AT)).toBeCloseTo(REVERSE_AT, 6);
  });

  it('mirrors the folding half back out again', () => {
    for (const offset of [0.1, 0.8, 1.6, 2.4, 3.1]) {
      expect(authoredTime(REVERSE_AT + offset)).toBeCloseTo(REVERSE_AT - offset, 6);
    }
  });

  it('comes back to a whole logo at the end of the loop', () => {
    // Not merely close to zero: the frame before the wrap and the frame after
    // it have to be the same picture, or the seam shows.
    expect(authoredTime(LOOP_SECONDS - 0.0001)).toBeCloseTo(0, 3);
    expect(authoredTime(LOOP_SECONDS)).toBeCloseTo(0, 6);
  });

  it('loops rather than running off the end', () => {
    expect(authoredTime(LOOP_SECONDS + 1.5)).toBeCloseTo(1.5, 6);
    expect(authoredTime(LOOP_SECONDS * 7 + 1.5)).toBeCloseTo(1.5, 6);
  });

  it('holds still at the start before any time has passed', () => {
    // What a paused mark shows, and what a student who has asked nothing sees.
    expect(authoredTime(-2)).toBeCloseTo(0, 6);
  });
});
