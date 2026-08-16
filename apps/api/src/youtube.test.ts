import { describe, expect, it } from 'vitest';
import { parseIsoDuration } from './youtube.js';

/** The Data API reports length as an ISO 8601 duration, never as seconds. */
describe('parseIsoDuration', () => {
  it('reads the shapes YouTube actually returns', () => {
    expect(parseIsoDuration('PT4M13S')).toBe(253);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('PT2M')).toBe(120);
    // Live streams and very long recordings carry a day component.
    expect(parseIsoDuration('P1DT2H')).toBe(93_600);
  });

  it('returns null rather than zero for things with no duration', () => {
    // A live stream reports P0D; zero would render as "0 minutes long".
    expect(parseIsoDuration('P0D')).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(parseIsoDuration('nonsense')).toBeNull();
  });
});
