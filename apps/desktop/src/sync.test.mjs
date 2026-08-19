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

describe('when the thing answering is not our API', () => {
  const stubRaw = (status, text) => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: status < 400, status, text: async () => text });
    return () => { globalThis.fetch = original; };
  };

  const snap = { portalId: 'veracross', origin: 'https://x.test', map: { exploredAt: '2026-09-01T00:00:00.000Z' }, redacted: false };

  it('explains a 404 instead of failing to parse it', async () => {
    // A server without these routes replies with HTML or plain text. Parsing
    // that raised "Unexpected non-whitespace character after JSON", which
    // told the student nothing.
    const { pushSnapshot } = await import('./sync.mjs');
    const restore = stubRaw(404, '404 Not Found');
    try {
      const error = await pushSnapshot({ apiBase: 'https://contextoagent.ai', token: 't' }, snap).catch((e) => e);
      expect(error.message).toMatch(/no device-linking API/);
      expect(error.message).toMatch(/contextoagent\.ai/);
      expect(error.message).not.toMatch(/JSON/i);
    } finally { restore(); }
  });

  it('explains an HTML page served with a 200', async () => {
    // Captive portals on school wifi do exactly this.
    const { pushSnapshot } = await import('./sync.mjs');
    const restore = stubRaw(200, '<!doctype html><title>Sign in to WiFi</title>');
    try {
      const error = await pushSnapshot({ apiBase: 'https://x.test', token: 't' }, snap).catch((e) => e);
      expect(error.message).toMatch(/not JSON|proxy or sign-in page/);
    } finally { restore(); }
  });

  it('still reports a real API error message when there is one', async () => {
    const { pushSnapshot } = await import('./sync.mjs');
    const restore = stubRaw(400, JSON.stringify({ message: 'That portal snapshot is too large to store.' }));
    try {
      const error = await pushSnapshot({ apiBase: 'https://x.test', token: 't' }, snap).catch((e) => e);
      expect(error.message).toBe('That portal snapshot is too large to store.');
    } finally { restore(); }
  });
});
