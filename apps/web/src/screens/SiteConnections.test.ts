import { describe, expect, it } from 'vitest';
import { merge, type ServerSite } from './SiteConnections.js';
import type { LocalSite } from '../lib/desktop.js';

const server = (over: Partial<ServerSite> = {}): ServerSite => ({
  portalId: 'veracross',
  origin: 'https://portals.veracross.com',
  capturedAt: '2026-08-19T14:00:00.000Z',
  enabled: true,
  needsLogin: false,
  pages: 3,
  ...over,
});

const local = (over: Partial<LocalSite> = {}): LocalSite => ({
  id: 'veracross',
  name: 'Veracross',
  url: 'https://portals.veracross.com/lcc/student',
  origin: 'https://portals.veracross.com',
  loggedInAt: '2026-08-19T12:00:00.000Z',
  ...over,
});

describe('merge', () => {
  it('keeps the address a site lives at, for its logo', () => {
    expect(merge([server()], [])[0]?.origin).toBe('https://portals.veracross.com');
    expect(merge([], [local({ id: 'moodle', name: 'Moodle' })])[0]?.origin).toBe(
      'https://portals.veracross.com',
    );
  });
  it('shows a site the app knows about but the server has never seen', () => {
    // Added in the app and not yet synced: the server list alone would show
    // nothing, which reads as the Add button having silently failed.
    expect(merge([], [local({ id: 'moodle', name: 'Moodle', loggedInAt: null })])).toEqual([
      expect.objectContaining({ id: 'moodle', label: 'Moodle', signedIn: false }),
    ]);
  });

  it('does not list a site twice when both sides know it', () => {
    const rows = merge([server()], [local()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe('3 pages');
  });

  it('treats a signed-out local site as signed out even if the server looks fine', () => {
    // The device is the authority on whether a session still exists there.
    const rows = merge([server({ needsLogin: false })], [local({ loggedInAt: null })]);
    expect(rows[0]?.signedIn).toBe(false);
  });

  it('carries the off switch through from the server', () => {
    expect(merge([server({ enabled: false })], [local()])[0]?.enabled).toBe(false);
  });

  it('describes an empty but healthy site without implying a problem', () => {
    expect(merge([server({ pages: 0 })], [])[0]?.detail).toBe('nothing published yet');
  });

  it('asks for a new sign-in when the server saw a login page', () => {
    expect(merge([server({ needsLogin: true })], [])[0]?.detail).toBe('needs signing in again');
  });

  it('works with no desktop app at all', () => {
    expect(merge([server()], [])).toHaveLength(1);
  });
});
