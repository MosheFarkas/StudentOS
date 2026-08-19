import { describe, expect, it } from 'vitest';
import { portalIdFor } from './operations.mjs';

/**
 * Portal ids name a directory on disk holding a school session, so they have
 * to be filesystem-safe and stable, and two portals must never collide onto
 * one profile -- that would put a student's Veracross login and their Mozaik
 * login in the same Chrome profile.
 */
describe('portalIdFor', () => {
  it.each([
    ['Veracross', 'veracross'],
    ['Mozaïk', 'moza-k'],
    ['My School Portal', 'my-school-portal'],
    ['  spaced  out  ', 'spaced-out'],
    ['../../etc/passwd', 'etc-passwd'],
    ['!!!', 'portal'],
    ['', 'portal'],
  ])('%s -> %s', (name, expected) => {
    expect(portalIdFor(name)).toBe(expected);
  });

  it('never collides with an id already in use', () => {
    const existing = [{ id: 'veracross' }, { id: 'veracross-2' }];
    expect(portalIdFor('Veracross', existing)).toBe('veracross-3');
  });

  it('produces nothing that could escape the profiles directory', () => {
    for (const name of ['../..', 'a/b/c', '..\\..\\x', './.']) {
      expect(portalIdFor(name)).not.toMatch(/[/\\.]/);
    }
  });
});

describe('forgetDevice', () => {
  it('drops the credential but keeps configured portals', async () => {
    // Unlinking from the web must not make a student re-add every portal.
    const { forgetDevice } = await import('./operations.mjs');
    const { readConfig, writeConfig } = await import('./sync.mjs');
    const original = readConfig();
    try {
      writeConfig({
        token: 't',
        deviceId: 'd',
        deviceName: 'n',
        apiBase: 'https://x.test',
        portals: [{ id: 'veracross' }],
      });
      forgetDevice();
      const after = readConfig();
      expect(after.token).toBeUndefined();
      expect(after.deviceId).toBeUndefined();
      expect(after.portals).toEqual([{ id: 'veracross' }]);
      expect(after.apiBase).toBe('https://x.test');
    } finally {
      writeConfig(original);
    }
  });
});

describe('coalesce', () => {
  it('joins a run already in flight rather than starting a second', async () => {
    // Two Chrome instances on one profile directory is a hard failure, and it
    // would be recorded as the portal being broken.
    const { coalesce } = await import('./operations.mjs');
    const map = new Map();
    let starts = 0;
    const slow = () => {
      starts += 1;
      return new Promise((r) => setTimeout(() => r('done'), 30));
    };

    const [a, b] = await Promise.all([
      coalesce(map, 'veracross', slow),
      coalesce(map, 'veracross', slow),
    ]);
    expect(starts).toBe(1);
    expect([a, b]).toEqual(['done', 'done']);
  });

  it('does not block a different portal', async () => {
    const { coalesce } = await import('./operations.mjs');
    const map = new Map();
    let starts = 0;
    const slow = () => {
      starts += 1;
      return new Promise((r) => setTimeout(r, 10));
    };
    await Promise.all([coalesce(map, 'veracross', slow), coalesce(map, 'mozaik', slow)]);
    expect(starts).toBe(2);
  });

  it('releases the slot after a failure, so a retry is possible', async () => {
    const { coalesce } = await import('./operations.mjs');
    const map = new Map();
    await expect(coalesce(map, 'x', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(map.size).toBe(0);
    await expect(coalesce(map, 'x', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
