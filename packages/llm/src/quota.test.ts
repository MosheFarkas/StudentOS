import { describe, expect, it } from 'vitest';
import { currentWindowEnd, currentWindowStart, platformCostMicroUsd } from './quota.js';
import { PLATFORM_PRICING } from './config.js';

describe('platformCostMicroUsd', () => {
  it('matches hand-computed pricing', () => {
    // 64 * 0.2 + 4 * 1.2 = 17.6 -> 18. These are the exact numbers observed on
    // the first real call against gpt-5.6-luna, so this pins the metering to
    // reality rather than to itself.
    expect(platformCostMicroUsd({ inputTokens: 64, outputTokens: 4, cachedInputTokens: 0 })).toBe(
      18,
    );
  });

  it('prices cached input at the discounted rate', () => {
    const cost = platformCostMicroUsd({
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 900,
    });

    // 100 uncached * 0.2 + 900 cached * 0.02 + 100 out * 1.2 = 20 + 18 + 120
    expect(cost).toBe(158);
  });

  it('makes caching materially cheaper, which is the whole reason it is metered', () => {
    const uncached = platformCostMicroUsd({
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 0,
    });
    const cached = platformCostMicroUsd({
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 900,
    });

    expect(cached).toBeLessThan(uncached / 1.9);
  });

  it('never double-counts cached tokens as uncached', () => {
    // cachedInputTokens is a SUBSET of inputTokens. Treating it as additional
    // would silently overstate every bill.
    const allCached = platformCostMicroUsd({
      inputTokens: 500,
      outputTokens: 0,
      cachedInputTokens: 500,
    });
    expect(allCached).toBe(Math.round(500 * PLATFORM_PRICING.cachedInputMicroUsdPerToken));
  });

  it('clamps rather than going negative if cached exceeds input', () => {
    // Defensive: a provider reporting cached > input should not produce a
    // negative cost that silently credits the account.
    expect(
      platformCostMicroUsd({ inputTokens: 10, outputTokens: 0, cachedInputTokens: 999 }),
    ).toBeGreaterThanOrEqual(0);
  });

  it('returns an integer, so sums cannot drift', () => {
    const cost = platformCostMicroUsd({
      inputTokens: 333,
      outputTokens: 77,
      cachedInputTokens: 11,
    });
    expect(Number.isInteger(cost)).toBe(true);
  });
});

describe('quota window', () => {
  it('starts at the first of the month, UTC', () => {
    const start = currentWindowStart(new Date('2026-08-13T18:45:00Z'));
    expect(start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('ends at the first of the next month', () => {
    const end = currentWindowEnd(new Date('2026-08-13T18:45:00Z'));
    expect(end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rolls over the year in December', () => {
    // Off-by-one here would give every student a free January.
    expect(currentWindowEnd(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('treats the very first instant of a month as the new window', () => {
    const start = currentWindowStart(new Date('2026-09-01T00:00:00Z'));
    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});
