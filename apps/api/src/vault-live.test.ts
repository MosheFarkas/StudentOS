import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bells } from './vault-live.js';

/**
 * Bells coalesce.
 *
 * Google rings once per mailbox change and once per keystroke's autosave in
 * Docs. Syncing on every one would be dozens of syncs for one edit; the
 * bell waits for quiet and then rings once, with everything that rang.
 */
describe('Bells', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rings once after quiet, with every source that rang', () => {
    const bells = new Bells({ gmail: 20_000, drive: 90_000 });
    const rang = vi.fn();
    bells.onRing(rang);

    bells.ring('s1', 'drive');
    vi.advanceTimersByTime(30_000);
    bells.ring('s1', 'drive');
    bells.ring('s1', 'gmail');
    expect(rang).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20_000);
    expect(rang).toHaveBeenCalledTimes(1);
    expect(rang).toHaveBeenCalledWith('s1', { gmail: true, drive: true });
    expect(bells.pending('s1')).toBe(false);
  });

  it('does not let a slow source push out a fast one', () => {
    const bells = new Bells({ gmail: 20_000, drive: 90_000 });
    const rang = vi.fn();
    bells.onRing(rang);
    bells.ring('s1', 'gmail');
    vi.advanceTimersByTime(10_000);
    bells.ring('s1', 'drive');
    vi.advanceTimersByTime(10_000);
    expect(rang).toHaveBeenCalledTimes(1);
  });

  it('keeps students apart', () => {
    const bells = new Bells({ gmail: 1000, drive: 1000 });
    const rang = vi.fn();
    bells.onRing(rang);
    bells.ring('s1', 'gmail');
    bells.ring('s2', 'drive');
    vi.advanceTimersByTime(1000);
    expect(rang).toHaveBeenCalledWith('s1', { gmail: true, drive: false });
    expect(rang).toHaveBeenCalledWith('s2', { gmail: false, drive: true });
  });
});
