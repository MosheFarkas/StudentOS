import { describe, expect, it } from 'vitest';
import { parseRoute, routeToPath } from './router.js';

describe('parseRoute', () => {
  it('maps the three real screens', () => {
    expect(parseRoute('/')).toEqual({ name: 'new' });
    expect(parseRoute('/agents')).toEqual({ name: 'new' });
    expect(parseRoute('/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('/agents/abc123')).toEqual({ name: 'chat', agentId: 'abc123' });
  });

  it('ignores a trailing slash', () => {
    expect(parseRoute('/settings/')).toEqual({ name: 'settings' });
    expect(parseRoute('/agents/abc123/')).toEqual({ name: 'chat', agentId: 'abc123' });
  });

  /**
   * The address bar is user input. Anything unrecognised has to land on a
   * real screen rather than rendering nothing, because with the SPA fallback
   * every path returns index.html -- so a typo reaches the app instead of a
   * 404 page.
   */
  it('sends unknown paths to notFound', () => {
    expect(parseRoute('/nope').name).toBe('notFound');
    expect(parseRoute('/agents/abc/extra').name).toBe('notFound');
    expect(parseRoute('/settings/deep').name).toBe('notFound');
  });

  it('round-trips through routeToPath', () => {
    for (const route of [
      { name: 'new' } as const,
      { name: 'settings' } as const,
      { name: 'chat', agentId: 'abc123' } as const,
    ]) {
      expect(parseRoute(routeToPath(route))).toEqual(route);
    }
  });

  /**
   * parse must invert routeToPath. Ids are UUIDs today, so this is about the
   * router being self-consistent rather than about a case that occurs -- but
   * a format whose parser does not reverse its own printer is a trap for
   * whoever changes the id scheme later.
   */
  it('round-trips an id that needs escaping', () => {
    const path = routeToPath({ name: 'chat', agentId: 'a b/c' });
    expect(path).toBe('/agents/a%20b%2Fc');
    expect(parseRoute(path)).toEqual({ name: 'chat', agentId: 'a b/c' });
  });

  it('does not throw on a malformed escape', () => {
    expect(() => parseRoute('/agents/%E0%A4%A')).not.toThrow();
  });
});
