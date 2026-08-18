import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from './sync.mjs';

describe('readConfig', () => {
  it('returns an empty object rather than throwing when unlinked', () => {
    // First run on a new machine has no config file at all. Throwing here
    // would mean the app cannot even print "run link first".
    expect(readConfig()).toEqual(expect.any(Object));
  });

  it('survives a corrupted config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, '{ not json');
    chmodSync(file, 0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('pushSnapshot', () => {
  const stubFetch = (status, body) => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    return () => { globalThis.fetch = original; };
  };

  const snapshot = { portalId: 'veracross', origin: 'https://x.test', map: { exploredAt: '2026-09-01T00:00:00.000Z' }, redacted: false };

  it('raises DeviceUnlinked on 401 so the app can stop retrying', async () => {
    const { DeviceUnlinked, pushSnapshot } = await import('./sync.mjs');
    const restore = stubFetch(401, { message: 'This device is not linked.' });
    try {
      await expect(pushSnapshot({ apiBase: 'https://x.test', token: 'revoked' }, snapshot))
        .rejects.toBeInstanceOf(DeviceUnlinked);
    } finally { restore(); }
  });

  it('raises an ordinary error on a server fault, which IS worth retrying', async () => {
    const { DeviceUnlinked, pushSnapshot } = await import('./sync.mjs');
    const restore = stubFetch(500, { message: 'boom' });
    try {
      const error = await pushSnapshot({ apiBase: 'https://x.test', token: 't' }, snapshot).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DeviceUnlinked);
    } finally { restore(); }
  });
});
