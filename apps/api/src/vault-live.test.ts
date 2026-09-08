import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unavailable } from '@contexto/agent';
import { Bells, driveTokenRejected } from './vault-live.js';

/**
 * Bells wait for quiet.
 *
 * Google rings once per mailbox change and once per keystroke's autosave in
 * Docs. Syncing on every one would be dozens of syncs for one edit; each
 * source waits for its own quiet, and the bell rings once with everything
 * that rang -- but never later than five minutes from the first ring, or a
 * student who keeps typing is never synced at all.
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

  it('holds a busy Drive back until it falls quiet', () => {
    // A student editing a document for four minutes: an autosave every thirty
    // seconds, and no reason to sync a document they are still writing.
    const bells = new Bells({ gmail: 20_000, drive: 90_000 });
    const rang = vi.fn();
    bells.onRing(rang);

    for (let elapsed = 0; elapsed < 4 * 60_000; elapsed += 30_000) {
      bells.ring('s1', 'drive');
      expect(bells.pending('s1')).toBe(true);
      vi.advanceTimersByTime(30_000);
    }
    expect(rang).not.toHaveBeenCalled();

    // Ninety seconds of quiet after the last save, not before.
    vi.advanceTimersByTime(59_000);
    expect(rang).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(rang).toHaveBeenCalledTimes(1);
    expect(rang).toHaveBeenCalledWith('s1', { gmail: false, drive: true });
  });

  it('rings anyway five minutes after the first ring', () => {
    // The quiet never comes -- a long writing session. Waiting for it would
    // mean the work of an afternoon reaching the vault that evening.
    const bells = new Bells({ gmail: 20_000, drive: 90_000 });
    const at: number[] = [];
    bells.onRing(() => at.push(Date.now()));

    const start = Date.now();
    for (let elapsed = 0; elapsed < 6 * 60_000; elapsed += 10_000) {
      bells.ring('s1', 'drive');
      vi.advanceTimersByTime(10_000);
    }
    expect(at[0]).toBe(start + 5 * 60_000);
  });
});

/**
 * Which Drive failures are worth throwing the change token away for.
 *
 * The change feed is the only path that removes a deleted file, so a token
 * reset on a passing failure loses every deletion since -- permanently, since
 * nothing later looks for notes whose file is gone.
 */
describe('driveTokenRejected', () => {
  it('is true for the failures that mean the token is dead', () => {
    expect(driveTokenRejected(unavailable('gone', { status: 404 }))).toBe(true);
    expect(driveTokenRejected(unavailable('gone', { status: 410 }))).toBe(true);
    expect(
      driveTokenRejected(
        unavailable('bad request', { status: 400, message: 'Invalid Value for pageToken' }),
      ),
    ).toBe(true);
    expect(
      driveTokenRejected(
        unavailable('bad request', { status: 400, message: 'Invalid page token.' }),
      ),
    ).toBe(true);
  });

  it('is false for a Google that is merely having a bad minute', () => {
    expect(driveTokenRejected(unavailable('server error', { status: 500 }))).toBe(false);
    expect(driveTokenRejected(unavailable('rate limited', { status: 429 }))).toBe(false);
    // A 400 about something else entirely. Only the page token condemns it.
    expect(
      driveTokenRejected(unavailable('bad request', { status: 400, message: 'Invalid field' })),
    ).toBe(false);
    expect(driveTokenRejected(unavailable('no status at all'))).toBe(false);
  });
});
