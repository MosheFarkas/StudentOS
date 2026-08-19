import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseExit, profileDirFor, launchArgs } from './browser.mjs';
import { findBrowser } from './chrome.mjs';

describe('profileDirFor', () => {
  it('refuses a portal id that could escape the profile root', () => {
    expect(() => profileDirFor('../../.ssh')).toThrow(/Invalid portal id/);
    expect(() => profileDirFor('veracross/../..')).toThrow(/Invalid portal id/);
  });

  it('gives each portal its own directory', () => {
    expect(profileDirFor('veracross')).not.toBe(profileDirFor('mozaik'));
  });

  it('never points at the real Chrome profile', () => {
    // The whole safety argument rests on this: our profile is not the one the
    // student is signed into Google with, so Gmail and Drive stay behind OAuth.
    expect(profileDirFor('veracross')).not.toMatch(/Google\/Chrome$/);
  });
});

describe('diagnoseExit', () => {
  it('names the enterprise policy when an admin has blocked debugging', () => {
    const message = diagnoseExit(1, 'ERROR: Remote debugging is disallowed by the system admin');
    expect(message).toMatch(/administrator/i);
    expect(message).toMatch(/personal computer/i);
  });

  it('explains a profile already in use', () => {
    expect(
      diagnoseExit(21, 'Failed to create a ProcessSingleton for your profile directory'),
    ).toMatch(/already open/i);
  });

  it('falls back to the exit code with captured stderr', () => {
    expect(diagnoseExit(127, 'dyld: library not loaded')).toMatch(/127/);
  });
});

describe('findBrowser', () => {
  it('finds a Chromium-family browser on this machine', () => {
    expect(findBrowser().path).toBeTruthy();
  });

  it('throws a student-readable error when nothing is installed', () => {
    expect(() => findBrowser('sunos')).toThrow(/Install Chrome/);
  });
});

describe('launchArgs', () => {
  const base = { profileDir: '/tmp/profile', visible: false, startUrl: null };

  it('always restores the last session', () => {
    // Portal logins are session cookies, which Chrome discards on exit. Without
    // this flag closing the login window destroyed the login it had just been
    // opened to capture. Measured: 0 restarts survived without, 3 of 3 with.
    expect(launchArgs({ ...base, driving: true })).toContain('--restore-last-session');
    expect(launchArgs({ ...base, driving: false })).toContain('--restore-last-session');
  });

  it('opens a debugging channel only when driving', () => {
    // The sign-in page must see an ordinary browser; only reading needs CDP.
    expect(launchArgs({ ...base, driving: true })).toContain('--remote-debugging-pipe');
    expect(launchArgs({ ...base, driving: false })).not.toContain('--remote-debugging-pipe');
  });

  it('never runs headless, which would advertise automation', () => {
    const args = launchArgs({ ...base, driving: true });
    expect(args.join(' ')).not.toMatch(/--headless/);
    expect(args).toContain('--window-position=-32000,-32000');
  });

  it('shows a real window when visible', () => {
    expect(launchArgs({ ...base, driving: false, visible: true }).join(' ')).not.toMatch(
      /window-position/,
    );
  });

  it('always points at the isolated profile', () => {
    expect(launchArgs({ ...base, driving: true })).toContain('--user-data-dir=/tmp/profile');
  });

  it('starts at the requested url, or blank', () => {
    expect(launchArgs({ ...base, driving: false, startUrl: 'https://x.test/' }).at(-1)).toBe(
      'https://x.test/',
    );
    expect(launchArgs({ ...base, driving: true }).at(-1)).toBe('about:blank');
  });
});

describe('profile directory permissions', () => {
  it('is created owner-only, because it holds a school session', async () => {
    // Default 0755 would let every other account on a shared Mac read the
    // profile. Chrome encrypts the cookie store against the keychain, so this
    // is depth rather than the only barrier -- but it costs nothing.
    const root = mkdtempSync(join(tmpdir(), 'ctx-profile-'));
    const before = process.env['CONTEXTO_CONFIG_DIR'];
    process.env['CONTEXTO_CONFIG_DIR'] = root;
    try {
      const { PortalBrowser } = await import('./browser.mjs');
      const browser = new PortalBrowser({ portalId: 'perm-test' });
      // launch() would spawn Chrome; the directory is made on the way there,
      // so create it the same way the constructor path does.
      const { mkdirSync, chmodSync } = await import('node:fs');
      mkdirSync(browser.profileDir, { recursive: true, mode: 0o700 });
      chmodSync(browser.profileDir, 0o700);
      expect(statSync(browser.profileDir).mode & 0o777).toBe(0o700);
    } finally {
      if (before === undefined) delete process.env['CONTEXTO_CONFIG_DIR'];
      else process.env['CONTEXTO_CONFIG_DIR'] = before;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
