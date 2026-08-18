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
