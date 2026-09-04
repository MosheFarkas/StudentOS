import { describe, expect, it } from 'vitest';
import { tokenExpiry } from './picker.js';

/**
 * How long a Drive token is treated as good for.
 *
 * The token is what costs a popup, so holding one is what stops a window
 * flashing open and shut every time a student attaches a file. Holding it a
 * moment too long is worse than not holding it at all: the Picker fails with a
 * permission error rather than an expiry, and nothing on screen says the token
 * was the problem.
 */
const NOW = 1_800_000_000_000;

describe('when a Drive token stops being usable', () => {
  it('expires a minute before Google says, so it cannot die in transit', () => {
    // The token is handed to the Picker and used over the seconds that follow.
    expect(tokenExpiry(3600, NOW)).toBe(NOW + 3540 * 1000);
  });

  it('takes the seconds as a string, which is how Google sometimes sends them', () => {
    expect(tokenExpiry('3600', NOW)).toBe(tokenExpiry(3600, NOW));
  });

  it('treats a token with no lifetime as already expired', () => {
    // Better a popup than a token trusted for ever that stopped working.
    expect(tokenExpiry(undefined, NOW)).toBe(NOW);
    expect(tokenExpiry('not a number', NOW)).toBe(NOW);
    expect(tokenExpiry(0, NOW)).toBe(NOW);
    expect(tokenExpiry(-5, NOW)).toBe(NOW);
  });

  it('never returns a time before now, however short the lifetime', () => {
    for (const seconds of [1, 30, 59, 60]) {
      expect(tokenExpiry(seconds, NOW)).toBeGreaterThanOrEqual(NOW);
    }
  });

  it('holds a full-length token long enough to be worth holding', () => {
    // The whole point: one popup a session rather than one a click.
    expect(tokenExpiry(3600, NOW) - NOW).toBeGreaterThan(50 * 60 * 1000);
  });
});
