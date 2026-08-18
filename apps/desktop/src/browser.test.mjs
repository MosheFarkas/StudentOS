import { describe, expect, it } from 'vitest';
import { diagnoseExit, profileDirFor } from './browser.mjs';
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
    expect(diagnoseExit(21, 'Failed to create a ProcessSingleton for your profile directory')).toMatch(
      /already open/i,
    );
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
