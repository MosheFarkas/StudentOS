import { describe, expect, it } from 'vitest';
import {
  CALENDAR_SCOPES,
  CLASSROOM_SCOPES,
  IDENTITY_SCOPES,
  grantedScopeGroups,
  scopesFor,
} from './scopes.js';

const all = (...groups: readonly (readonly string[])[]) => groups.flat().join(' ');

describe('grantedScopeGroups', () => {
  it('returns nothing for missing or empty input', () => {
    expect(grantedScopeGroups(null)).toEqual([]);
    expect(grantedScopeGroups(undefined)).toEqual([]);
    expect(grantedScopeGroups('')).toEqual([]);
    expect(grantedScopeGroups('   ')).toEqual([]);
  });

  it('recognises a fully granted group', () => {
    expect(grantedScopeGroups(all(IDENTITY_SCOPES))).toEqual(['identity']);
  });

  /**
   * The security-relevant case. A partially granted group must NOT count, or
   * buildToolRegistry would register a tool whose API calls are guaranteed to
   * 403 -- and the student would see a broken feature rather than an
   * unconnected one.
   */
  it('does not count a partially granted group', () => {
    expect(grantedScopeGroups(CLASSROOM_SCOPES[0])).toEqual([]);

    const missingProfile = [IDENTITY_SCOPES[0], IDENTITY_SCOPES[1]].join(' ');
    expect(grantedScopeGroups(missingProfile)).toEqual([]);
  });

  it('recognises several groups at once', () => {
    const granted = grantedScopeGroups(all(IDENTITY_SCOPES, CALENDAR_SCOPES, CLASSROOM_SCOPES));
    expect(granted.sort()).toEqual(['calendar', 'classroom', 'identity']);
  });

  it('tolerates extra scopes Google adds on its own', () => {
    // Google echoes back shorthand aliases like `email` and `profile` alongside
    // the canonical URLs. Unknown extras must not break detection.
    const withExtras = `email profile ${all(IDENTITY_SCOPES, CALENDAR_SCOPES)} https://example.com/other`;
    expect(grantedScopeGroups(withExtras).sort()).toEqual(['calendar', 'identity']);
  });

  it('handles arbitrary whitespace between scopes', () => {
    expect(grantedScopeGroups(IDENTITY_SCOPES.join('   \n '))).toEqual(['identity']);
  });

  /**
   * Regression: Better Auth stores the granted scopes COMMA-separated, not
   * space-separated as Google returns them.
   *
   * This string is copied verbatim from the account row after a real Google
   * grant in production. The original tests all used space-separated input --
   * they asserted the assumption rather than reality, so they passed while
   * every connection silently reported disconnected.
   */
  it('parses the comma-separated form Better Auth actually stores', () => {
    const fromProduction =
      'https://www.googleapis.com/auth/userinfo.email,' +
      'https://www.googleapis.com/auth/userinfo.profile,' +
      'https://www.googleapis.com/auth/calendar.events,' +
      'openid';

    expect(grantedScopeGroups(fromProduction).sort()).toEqual(['calendar', 'identity']);
  });

  it('parses comma-separated Classroom scopes', () => {
    const withClassroom = [...IDENTITY_SCOPES, ...CLASSROOM_SCOPES].join(',');
    expect(grantedScopeGroups(withClassroom).sort()).toEqual(['classroom', 'identity']);
  });

  it('handles either separator, and both mixed', () => {
    // Neither format is guaranteed: Google speaks spaces, Better Auth writes
    // commas, and a future adapter change could produce either.
    const mixed = `${IDENTITY_SCOPES.join(',')} ${CALENDAR_SCOPES.join(',')}`;
    expect(grantedScopeGroups(mixed).sort()).toEqual(['calendar', 'identity']);
  });
});

describe('scopesFor', () => {
  it('expands groups into their scopes', () => {
    expect(scopesFor(['calendar'])).toEqual([...CALENDAR_SCOPES]);
  });

  it('deduplicates across overlapping groups', () => {
    const scopes = scopesFor(['identity', 'identity', 'calendar']);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('round-trips: requesting a union grants exactly that union', () => {
    // This is the property the Telegram/Google connect flow depends on --
    // asking for the union of old + new must not drop the old ones.
    const requested = scopesFor(['identity', 'calendar', 'classroom']);
    expect(grantedScopeGroups(requested.join(' ')).sort()).toEqual([
      'calendar',
      'classroom',
      'identity',
    ]);
  });
});
