import { describe, expect, it } from 'vitest';
import { BANDS, bandFor, greetingsFor, pickGreeting } from './greeting.js';
import type { Band } from './greeting.js';

/** Predictable stand-in for Math.random: hands back the given values in turn. */
const rolls = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
};

/**
 * A date at a given weekday and hour, local time.
 *
 * 2026-01-04 was a Sunday, so adding the weekday index lands on the day meant
 * without any arithmetic at the call site. Local rather than UTC on purpose:
 * the greeting is about the clock on the student's wall.
 */
const at = (weekday: number, hour: number) => new Date(2026, 0, 4 + weekday, hour, 0, 0);

describe('reading the band off the clock', () => {
  it('splits the day into morning, afternoon, evening and night', () => {
    expect(bandFor(at(3, 8))).toBe('morning');
    expect(bandFor(at(3, 14))).toBe('afternoon');
    expect(bandFor(at(3, 19))).toBe('evening');
    expect(bandFor(at(3, 2))).toBe('night');
  });

  it('puts every hour of the clock in exactly one band', () => {
    const seen = new Set<Band>();
    for (let hour = 0; hour < 24; hour += 1) {
      const band = bandFor(at(3, hour));
      expect(BANDS).toContain(band);
      seen.add(band);
    }
    expect(seen.size).toBe(BANDS.length);
  });

  it('treats the small hours as night rather than morning', () => {
    // 1am is not "morning" to anyone who is awake for it.
    expect(bandFor(at(3, 1))).toBe('night');
    expect(bandFor(at(3, 4))).toBe('night');
    expect(bandFor(at(3, 5))).toBe('morning');
  });
});

describe('the greetings that suit a moment', () => {
  it('offers something for every hour of every day', () => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        expect(greetingsFor(at(weekday, hour)).length).toBeGreaterThan(0);
      }
    }
  });

  it('never leaves a name placeholder unfilled', () => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        for (const greeting of greetingsFor(at(weekday, hour), 'Lucas')) {
          expect(greeting).not.toContain('{');
          expect(greeting).not.toContain('undefined');
          expect(greeting.trim()).toBe(greeting);
          expect(greeting.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('drops the greetings that need a name when there is not one', () => {
    // Without a name those lines cannot be written, so they must not be
    // offered -- an empty gap where a name belongs reads as a bug.
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        for (const greeting of greetingsFor(at(weekday, hour))) {
          expect(greeting).not.toContain('{');
          expect(greeting).not.toContain('  ');
        }
      }
    }
  });

  it('writes the name in when there is one', () => {
    const withName = greetingsFor(at(3, 9), 'Lucas');
    expect(withName.some((line) => line.includes('Lucas'))).toBe(true);
  });

  it('says something different at 2am than at 2pm', () => {
    const night = greetingsFor(at(3, 2));
    const afternoon = greetingsFor(at(3, 14));
    expect(night).not.toEqual(afternoon);
    expect(night.some((line) => afternoon.includes(line))).toBe(false);
  });

  it('knows what day it is on the days that feel different', () => {
    // Monday, Friday and Sunday evening are the three a student actually
    // feels. The rest of the week is just the time of day.
    expect(greetingsFor(at(1, 9)).some((line) => /monday/i.test(line))).toBe(true);
    expect(greetingsFor(at(5, 15)).some((line) => /friday/i.test(line))).toBe(true);
    expect(greetingsFor(at(0, 19)).some((line) => /sunday/i.test(line))).toBe(true);
  });

  it('does not name a weekday on a day that is unremarkable', () => {
    for (const greeting of greetingsFor(at(3, 14))) {
      expect(greeting).not.toMatch(/monday|friday|sunday|saturday/i);
    }
  });

  it('keeps the day-specific lines to their own day', () => {
    // A Monday line on a Wednesday is worse than no line at all.
    expect(greetingsFor(at(3, 9)).some((line) => /monday/i.test(line))).toBe(false);
    expect(greetingsFor(at(2, 15)).some((line) => /friday/i.test(line))).toBe(false);
  });
});

describe('choosing one', () => {
  it('returns one of the greetings that suit the moment', () => {
    const now = at(3, 9);
    const pool = greetingsFor(now, 'Lucas');
    expect(pool).toContain(pickGreeting(now, 'Lucas', rolls(0)));
    expect(pool).toContain(pickGreeting(now, 'Lucas', rolls(0.999)));
  });

  it('reaches every greeting in the pool, not just the first', () => {
    const now = at(3, 9);
    const pool = greetingsFor(now);
    const reached = new Set(
      pool.map((_, i) => pickGreeting(now, undefined, rolls(i / pool.length))),
    );
    expect(reached.size).toBe(pool.length);
  });

  it('always says something, whatever the clock says', () => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        expect(pickGreeting(at(weekday, hour), 'Lucas', rolls(0.5))).toBeTruthy();
      }
    }
  });
});
