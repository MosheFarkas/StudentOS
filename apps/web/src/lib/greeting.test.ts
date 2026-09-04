import { describe, expect, it } from 'vitest';
import {
  BANDS,
  WINDOW_MS,
  bandFor,
  firstName,
  greetingsFor,
  pickGreeting,
  windowStart,
} from './greeting.js';
import type { Band } from './greeting.js';

/**
 * 2026-01-04 was a Sunday, so adding the weekday index lands on the day meant
 * without arithmetic at the call site. Local rather than UTC on purpose: the
 * greeting is about the clock on the student's wall.
 */
const at = (weekday: number, hour: number, minute = 0) =>
  new Date(2026, 0, 4 + weekday, hour, minute, 0);

describe('reading the band off the clock', () => {
  it('splits the day into morning, afternoon, evening and night', () => {
    expect(bandFor(at(3, 8))).toBe('morning');
    expect(bandFor(at(3, 14))).toBe('afternoon');
    expect(bandFor(at(3, 19))).toBe('evening');
    expect(bandFor(at(3, 2))).toBe('night');
  });

  it('puts every hour in exactly one band, and uses all four', () => {
    const seen = new Set<Band>();
    for (let hour = 0; hour < 24; hour += 1) {
      const band = bandFor(at(3, hour));
      expect(BANDS).toContain(band);
      seen.add(band);
    }
    expect(seen.size).toBe(BANDS.length);
  });

  it('treats the small hours as night rather than morning', () => {
    expect(bandFor(at(3, 1))).toBe('night');
    expect(bandFor(at(3, 4))).toBe('night');
    expect(bandFor(at(3, 5))).toBe('morning');
  });
});

describe('the name they are greeted by', () => {
  it('is the first word of it', () => {
    // Google hands over a full name, and "Hey, Lucas Liu." is how a dentist's
    // receptionist says it.
    expect(firstName('Lucas Liu')).toBe('Lucas');
    expect(firstName('  Lucas  Liu ')).toBe('Lucas');
    expect(firstName('Lucas')).toBe('Lucas');
  });

  it('survives a name that is only spaces', () => {
    expect(firstName('   ')).toBe('');
  });
});

describe('holding a greeting still', () => {
  it('says the same thing all the way through a three-hour window', () => {
    const first = pickGreeting(at(3, 9, 1), 'Lucas');
    for (const minute of [2, 30, 59, 119, 179]) {
      expect(pickGreeting(at(3, 9, minute), 'Lucas')).toBe(first);
    }
  });

  it('survives a reload, because nothing is stored', () => {
    // Two independent calls at different instants in one window agree.
    expect(pickGreeting(at(3, 13, 5), 'Lucas')).toBe(pickGreeting(at(3, 14, 55), 'Lucas'));
  });

  it('aligns windows to local midnight rather than the epoch', () => {
    expect(windowStart(at(3, 0, 10)).getHours()).toBe(0);
    expect(windowStart(at(3, 4, 59)).getHours()).toBe(3);
    expect(windowStart(at(3, 9, 1)).getHours()).toBe(9);
    expect(windowStart(at(3, 23, 59)).getHours()).toBe(21);
  });

  it('is not the same line for ever', () => {
    // Across a day's worth of windows the choice actually moves.
    const seen = new Set<string>();
    for (let hour = 0; hour < 24; hour += 3) seen.add(pickGreeting(at(3, hour), 'Lucas'));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('does not greet two students identically at the same moment', () => {
    const moment = at(3, 9);
    expect(pickGreeting(moment, 'Lucas')).not.toBe(pickGreeting(moment, 'Priya'));
  });

  it('moves on at the window boundary', () => {
    const before = windowStart(at(3, 9, 30));
    const after = new Date(before.getTime() + WINDOW_MS);
    expect(windowStart(after).getTime()).toBe(after.getTime());
  });
});

describe('what a greeting says', () => {
  it('never leaves a placeholder unfilled, at any hour of any day', () => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        for (const line of greetingsFor(at(weekday, hour), 'Lucas Liu', 3)) {
          expect(line).not.toMatch(/\[[a-z_]+\]/);
          expect(line).not.toContain('undefined');
          expect(line.trim()).toBe(line);
          expect(line.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('uses the first name only', () => {
    const lines = greetingsFor(at(3, 9), 'Lucas Liu');
    expect(lines.some((line) => line.includes('Lucas'))).toBe(true);
    expect(lines.some((line) => line.includes('Liu'))).toBe(false);
  });

  it('drops the lines that need a name when there is none', () => {
    for (const line of greetingsFor(at(3, 9))) {
      expect(line).not.toMatch(/\[[a-z_]+\]/);
      expect(line).not.toMatch(/\s,|,\s*$/);
    }
  });

  it('drops the round-number line unless a number is given', () => {
    // Inventing "Round 5?" for someone's second visit would be a lie the
    // greeting has no way to make true.
    expect(greetingsFor(at(3, 9), 'Lucas').some((l) => /^Round /.test(l))).toBe(false);
    expect(greetingsFor(at(3, 9), 'Lucas', 4)).toContain('Round 4, Lucas?');
  });

  it('offers something at every hour of every day', () => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        expect(greetingsFor(at(weekday, hour), 'Lucas').length).toBeGreaterThan(0);
        expect(pickGreeting(at(weekday, hour), 'Lucas')).toBeTruthy();
      }
    }
  });
});

describe('the lines that are pinned to a time', () => {
  const linesAt = (weekday: number, hour: number) => greetingsFor(at(weekday, hour), 'Lucas');

  it('says rise and shine in the morning and never at night', () => {
    expect(linesAt(3, 7)).toContain('Rise and shine, Lucas.');
    expect(linesAt(3, 23)).not.toContain('Rise and shine, Lucas.');
  });

  it('asks if you are still up only at night', () => {
    expect(linesAt(3, 1)).toContain('Still up, Lucas?');
    expect(linesAt(3, 9)).not.toContain('Still up, Lucas?');
  });

  it('offers weekend mode only at the weekend', () => {
    expect(linesAt(6, 11)).toContain('Weekend mode, Lucas?');
    expect(linesAt(3, 11)).not.toContain('Weekend mode, Lucas?');
  });

  it('names tomorrow when the line is about tomorrow', () => {
    // Wednesday, so "Almost" means Thursday.
    expect(linesAt(3, 14)).toContain('Almost Thursday, Lucas.');
  });

  it('names today everywhere else', () => {
    expect(linesAt(3, 14)).toContain('Happy Wednesday, Lucas.');
  });

  it('wraps the weekday around the end of the week', () => {
    // Saturday's tomorrow is Sunday, not an eighth day.
    expect(linesAt(6, 14)).toContain('Almost Sunday, Lucas.');
  });

  it('writes the time of day into the lines that ask for it', () => {
    expect(linesAt(3, 14)).toContain('Good afternoon, Lucas.');
    expect(linesAt(3, 8)).toContain('Good morning, Lucas.');
  });
});
