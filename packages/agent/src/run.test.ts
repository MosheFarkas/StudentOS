import { describe, expect, it } from 'vitest';
import { currentTimeSection } from './run.js';

/**
 * Temporal grounding.
 *
 * A model has no clock. Without this the agent cannot turn "tomorrow at 3pm"
 * into an ISO timestamp, so it interrogates the student instead of acting --
 * which is what it did on the first live write attempt.
 */
describe('currentTimeSection', () => {
  const noon = new Date('2026-08-14T16:00:00Z');

  it('states the local time and the offset', () => {
    const section = currentTimeSection('America/New_York', noon);

    expect(section).toContain('America/New_York');
    // 16:00 UTC is 12:00 EDT.
    expect(section).toContain('12:00');
    // The offset is what makes a valid ISO string possible; a zone name alone
    // is not enough, and it shifts with daylight saving.
    expect(section).toContain('GMT-04:00');
  });

  it('reflects daylight saving rather than a fixed offset', () => {
    const winter = new Date('2026-01-14T16:00:00Z');
    expect(currentTimeSection('America/New_York', winter)).toContain('GMT-05:00');
    expect(currentTimeSection('America/New_York', noon)).toContain('GMT-04:00');
  });

  it('falls back to UTC when no timezone is known', () => {
    const section = currentTimeSection(undefined, noon);
    expect(section).toContain('UTC');
  });

  it('tells the agent not to ask', () => {
    // The behaviour being fixed: the agent asked "what timezone?" instead of
    // creating the event.
    expect(currentTimeSection('Europe/London', noon)).toMatch(/do not ask/i);
  });

  it('survives a bogus timezone instead of throwing', () => {
    // A bad value must not take down every turn for that student.
    const section = currentTimeSection('Not/AZone', noon);
    expect(section).toContain('UTC');
    expect(section).toContain('2026-08-14');
  });

  it('gets the date right across a day boundary', () => {
    // 23:30 UTC is already the next day in Tokyo. Getting this wrong schedules
    // everything a day off.
    const lateUtc = new Date('2026-08-14T23:30:00Z');
    expect(currentTimeSection('Asia/Tokyo', lateUtc)).toContain('15 August 2026');
    expect(currentTimeSection('UTC', lateUtc)).toContain('14 August 2026');
  });
});
