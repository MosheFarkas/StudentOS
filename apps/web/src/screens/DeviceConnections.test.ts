import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastSynced } from './DeviceConnections.js';

const NOW = new Date('2026-09-05T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe('lastSynced', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('says so when a computer has never reported', () => {
    expect(lastSynced(null)).toBe('Never synced');
  });

  it('calls the last minute or two now', () => {
    expect(lastSynced(ago(1))).toBe('Syncing now');
  });

  it('reads as a sentence at every scale', () => {
    expect(lastSynced(ago(35))).toBe('Last synced 35 minutes ago');
    expect(lastSynced(ago(11 * 60))).toBe('Last synced 11 hours ago');
    expect(lastSynced(ago(3 * 24 * 60))).toBe('Last synced 3 days ago');
  });

  it('does not pluralise one', () => {
    expect(lastSynced(ago(60))).toBe('Last synced 1 hour ago');
    expect(lastSynced(ago(24 * 60))).toBe('Last synced 1 day ago');
  });
});
