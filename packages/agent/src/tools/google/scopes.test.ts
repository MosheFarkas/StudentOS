import { describe, expect, it } from 'vitest';
import {
  CLASSROOM_COURSES_SCOPE,
  CLASSROOM_COURSEWORK_SCOPE,
  CLASSROOM_COURSEWORK_WRITE_SCOPE,
  CLASSROOM_SUBMISSIONS_SCOPE,
  DRIVE_FILE_SCOPE,
  DRIVE_READONLY_SCOPE,
  ELECTIVE_SCOPES,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READ_SCOPE,
  SCOPE_GROUPS,
  grantedScopeGroups,
  hasScope,
  missingOptionalScopes,
  parseGrantedScopes,
  scopesFor,
} from './scopes.js';

const IDENTITY_SCOPES = SCOPE_GROUPS.identity.required;
const CLASSROOM_SCOPES = [...SCOPE_GROUPS.classroom.required, ...SCOPE_GROUPS.classroom.optional];
const GMAIL_SCOPES = [...SCOPE_GROUPS.gmail.required, ...SCOPE_GROUPS.gmail.optional];

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
  it('does not count a group missing a REQUIRED scope', () => {
    const missingProfile = [IDENTITY_SCOPES[0], IDENTITY_SCOPES[1]].join(' ');
    expect(grantedScopeGroups(missingProfile)).toEqual([]);
  });

  /**
   * Regression: a school account granted 5 of 6 Classroom scopes and the whole
   * integration reported disconnected. Optional scopes must not gate the
   * group -- admins granting subsets is routine, not exceptional.
   */
  it('counts a group whose required scope is present but optional ones are not', () => {
    expect(grantedScopeGroups(CLASSROOM_COURSES_SCOPE)).toEqual(['classroom']);
  });

  it('reports which optional scopes are missing', () => {
    const missing = missingOptionalScopes('classroom', CLASSROOM_COURSES_SCOPE);
    expect(missing).toContain(CLASSROOM_COURSEWORK_SCOPE);
  });

  it('reports nothing missing when everything was granted', () => {
    expect(missingOptionalScopes('classroom', CLASSROOM_SCOPES.join(','))).toEqual([]);
  });

  it('recognises several groups at once', () => {
    const granted = grantedScopeGroups(all(IDENTITY_SCOPES, GMAIL_SCOPES, CLASSROOM_SCOPES));
    expect(granted.sort()).toEqual(['classroom', 'gmail', 'identity']);
  });

  it('tolerates extra scopes Google adds on its own', () => {
    // Google echoes back shorthand aliases like `email` and `profile` alongside
    // the canonical URLs. Unknown extras must not break detection.
    const withExtras = `email profile ${all(IDENTITY_SCOPES, GMAIL_SCOPES)} https://example.com/other`;
    expect(grantedScopeGroups(withExtras).sort()).toEqual(['gmail', 'identity']);
  });

  it('handles arbitrary whitespace between scopes', () => {
    expect(grantedScopeGroups(IDENTITY_SCOPES.join('   \n '))).toEqual(['identity']);
  });

  /**
   * Regression: Better Auth stores the granted scopes COMMA-separated, not
   * space-separated as Google returns them.
   *
   * This is the shape of the account row after a real Google grant. The
   * original tests all used space-separated input -- they asserted the
   * assumption rather than reality, so they passed while every connection
   * silently reported disconnected.
   */
  it('parses the comma-separated form Better Auth actually stores', () => {
    const fromProduction =
      'https://www.googleapis.com/auth/userinfo.email,' +
      'https://www.googleapis.com/auth/userinfo.profile,' +
      'https://www.googleapis.com/auth/gmail.readonly,' +
      'openid';

    expect(grantedScopeGroups(fromProduction).sort()).toEqual(['gmail', 'identity']);
  });

  it('parses comma-separated Classroom scopes', () => {
    const withClassroom = [...IDENTITY_SCOPES, ...CLASSROOM_SCOPES].join(',');
    expect(grantedScopeGroups(withClassroom).sort()).toEqual(['classroom', 'identity']);
  });

  it('handles either separator, and both mixed', () => {
    // Neither format is guaranteed: Google speaks spaces, Better Auth writes
    // commas, and a future adapter change could produce either.
    const mixed = `${IDENTITY_SCOPES.join(',')} ${GMAIL_SCOPES.join(',')}`;
    expect(grantedScopeGroups(mixed).sort()).toEqual(['gmail', 'identity']);
  });
});

describe('scopesFor', () => {
  it('expands groups into their scopes', () => {
    expect(scopesFor(['drive'])).toEqual([DRIVE_FILE_SCOPE]);
  });

  it('deduplicates across overlapping groups', () => {
    const scopes = scopesFor(['identity', 'identity', 'drive']);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('round-trips: requesting a union grants exactly that union', () => {
    // This is the property the connect flow depends on -- asking for the
    // union of old + new must not drop the old ones.
    const requested = scopesFor(['identity', 'gmail', 'classroom']);
    expect(grantedScopeGroups(requested.join(' ')).sort()).toEqual([
      'classroom',
      'gmail',
      'identity',
    ]);
  });
});

describe('elective scopes', () => {
  /**
   * Elective scopes are NOT requested by default. drive.readonly is a real
   * decision with a real cost, and putting it on a consent screen a student
   * did not ask for takes that decision for them -- on a school account it
   * can also get the whole app refused.
   */
  it('are absent unless asked for', () => {
    expect(scopesFor(['drive'])).toEqual([DRIVE_FILE_SCOPE]);
  });

  it('are included when asked for', () => {
    expect(scopesFor(['drive'], [DRIVE_READONLY_SCOPE])).toContain(DRIVE_READONLY_SCOPE);
  });

  /**
   * The silent-downgrade trap. Google issues a token carrying exactly what was
   * requested, so connecting Classroom without re-requesting a held elective
   * scope would revoke full Drive access -- with no error, and no sign to the
   * student beyond their agent quietly losing the ability to read files.
   */
  it('survive connecting an unrelated group', () => {
    const scopes = scopesFor(['classroom', 'drive'], [DRIVE_READONLY_SCOPE]);
    expect(scopes).toContain(DRIVE_READONLY_SCOPE);
    expect(scopes).toContain(CLASSROOM_COURSES_SCOPE);
  });

  /** Never let an arbitrary caller-supplied string reach a consent screen. */
  it('ignore scopes that are not declared elective anywhere', () => {
    const scopes = scopesFor(['drive'], ['https://www.googleapis.com/auth/gmail.readonly']);
    expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.readonly');
  });

  /** Full read covers per-file read, so it must not read as disconnected. */
  it('treat drive.readonly as satisfying the drive group', () => {
    expect(grantedScopeGroups(DRIVE_READONLY_SCOPE)).toContain('drive');
  });
});

describe('coursework readability', () => {
  /**
   * Measured against a real school account: with student-submissions granted
   * and coursework.me.readonly withheld, courseWork.list still returned 188
   * assignments with titles and due dates.
   *
   * Before this, the assignments tool was gated on coursework.me.readonly
   * alone, so it was never registered for that student -- the single most
   * useful Classroom capability, silently absent, with nothing to indicate
   * it was a gating mistake rather than a school restriction.
   */
  it('treats student-submissions as enough to read assignments', () => {
    const granted = parseGrantedScopes(
      [CLASSROOM_COURSES_SCOPE, CLASSROOM_SUBMISSIONS_SCOPE].join(','),
    );
    expect(hasScope(CLASSROOM_COURSEWORK_SCOPE, granted)).toBe(true);
  });

  it('still reports nothing when neither is granted', () => {
    const granted = parseGrantedScopes(CLASSROOM_COURSES_SCOPE);
    expect(hasScope(CLASSROOM_COURSEWORK_SCOPE, granted)).toBe(false);
  });
});

describe('the write half of an integration', () => {
  /**
   * One decision, not two. Connecting Classroom is connecting the whole of
   * it, turning work in included; there is no second consent and no second
   * switch. The student's control is the integration itself.
   */
  it('requests turning work in with the rest of Classroom', () => {
    expect(scopesFor(['classroom'])).toContain(CLASSROOM_COURSEWORK_WRITE_SCOPE);
  });

  it('requests sending with reading mail', () => {
    expect(scopesFor(['gmail'])).toContain(GMAIL_MODIFY_SCOPE);
    expect(scopesFor(['gmail'])).toContain(GMAIL_READ_SCOPE);
  });

  /**
   * A school can still withhold it. Then it is a missing piece of a working
   * connection, reported like any other, not a disconnected integration.
   */
  it('counts a refused write scope as missing, not as disconnected', () => {
    expect(grantedScopeGroups(GMAIL_READ_SCOPE)).toContain('gmail');
    expect(missingOptionalScopes('gmail', GMAIL_READ_SCOPE)).toContain(GMAIL_MODIFY_SCOPE);
  });

  /** gmail.modify supersedes readonly; a student who granted it is connected. */
  it('treats modify as satisfying read', () => {
    expect(grantedScopeGroups(GMAIL_MODIFY_SCOPE)).toContain('gmail');
  });

  /**
   * https://mail.google.com/ is the only scope that can permanently delete
   * mail. It must never appear in anything this app requests, so the worst an
   * injected instruction can achieve is a recoverable trip to Trash.
   */
  it('never requests permanent-delete access anywhere', () => {
    const everything = scopesFor(['identity', 'classroom', 'drive', 'gmail'], ELECTIVE_SCOPES);
    expect(everything).not.toContain('https://mail.google.com/');
    expect(everything.some((s) => s.includes('gmail.settings'))).toBe(false);
  });
});
