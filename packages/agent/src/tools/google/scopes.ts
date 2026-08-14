/**
 * Google OAuth scope groups.
 *
 * Requested as three SEPARATE consents, not one. A student signs in first, and
 * is asked for Calendar (and later Classroom) only at the point they try to use
 * a feature that needs it. This is incremental authorisation, and it matters
 * for two reasons: a first-run consent screen listing every scope converts
 * badly, and Classroom in particular is unavailable to a large share of our
 * target users -- see the gating note at the bottom of this file.
 */

/** Always requested. Enough to create an account and nothing more. */
export const IDENTITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const;

/**
 * Requested when a student connects their calendar.
 *
 * `calendar.events` is read/write on events but does not permit deleting
 * calendars. Narrow to `calendar.readonly` if the agent only ever reads --
 * a smaller scope is a materially easier sell to a school IT reviewer.
 */
export const CALENDAR_SCOPES = [
  /*
   * Full calendar access: read, create, update, and delete events, and manage
   * calendars themselves.
   *
   * Still a SENSITIVE scope, same review tier as the narrower
   * calendar.events -- so the broader grant costs nothing extra in
   * verification. Restricted scopes are the expensive tier, and no Calendar
   * scope is restricted.
   */
  'https://www.googleapis.com/auth/calendar',
] as const;

/**
 * Requested only if a student opts into Classroom. Read-only by design: the
 * agent should never be able to submit work on a student's behalf.
 */
export const CLASSROOM_SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/classroom.topics.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
] as const;

/*
 * Classroom is read-only ON PURPOSE, and widening it is a bigger decision than
 * it looks:
 *
 *   COST. Classroom write scopes (submitting coursework, modifying courses)
 *   and roster/profile scopes are RESTRICTED, not sensitive. Restricted scopes
 *   require a CASA security assessment that must be REDONE ANNUALLY -- an
 *   ongoing cost and review cycle, not a one-time hurdle. Every scope above is
 *   sensitive, the same tier as Calendar, so they add no new review burden.
 *
 *   ADMIN APPROVAL. School admins grant specific scope lists. A read-only
 *   request is a far easier yes than one that can submit work, and admin
 *   approval is a prerequisite for the entire under-18 segment.
 *
 *   ACADEMIC INTEGRITY. An agent that can turn in coursework can turn in the
 *   wrong thing, at the wrong time, under a student's name. That is a
 *   liability question, not just a product one.
 *
 * If we do want write access, it should be a deliberate decision with the
 * assessment budgeted -- not something that arrives by adding a scope.
 */

export type ScopeGroup = 'identity' | 'calendar' | 'classroom';

export const SCOPE_GROUPS: Record<ScopeGroup, readonly string[]> = {
  identity: IDENTITY_SCOPES,
  calendar: CALENDAR_SCOPES,
  classroom: CLASSROOM_SCOPES,
};

/**
 * Which groups a student has granted, derived from the space-separated `scope`
 * string Better Auth stores on the `account` row. A group counts as granted
 * only if every scope in it is present.
 */
/**
 * Narrower scopes that still satisfy a broader requirement.
 *
 * Google's scopes are hierarchical, and widening what we REQUEST must not
 * disconnect students who already granted something sufficient. A student who
 * connected before we asked for full calendar access holds calendar.events --
 * which covers every event tool we ship, read and write. Forcing them to
 * reconnect for a capability they already have would be a self-inflicted
 * outage.
 *
 * Reconnecting still upgrades them; it is just not required.
 */
const ALSO_SATISFIED_BY: Record<string, readonly string[]> = {
  'https://www.googleapis.com/auth/calendar': ['https://www.googleapis.com/auth/calendar.events'],
};

function isGranted(scope: string, granted: Set<string>): boolean {
  if (granted.has(scope)) return true;
  return (ALSO_SATISFIED_BY[scope] ?? []).some((alternative) => granted.has(alternative));
}

export function grantedScopeGroups(grantedScope: string | null | undefined): ScopeGroup[] {
  if (!grantedScope) return [];

  /*
   * Split on commas AND whitespace.
   *
   * Google returns granted scopes space-separated, but Better Auth normalises
   * them to a comma-separated string before storing. Splitting on whitespace
   * alone turns the whole value into one token, so nothing matches and every
   * integration silently reports disconnected -- with the grant itself, and the
   * refresh token, perfectly intact in the same row.
   *
   * Accepting both means an adapter change in either direction cannot break it.
   */
  const granted = new Set(grantedScope.split(/[\s,]+/).filter(Boolean));

  return (Object.keys(SCOPE_GROUPS) as ScopeGroup[]).filter((group) =>
    SCOPE_GROUPS[group].every((scope) => isGranted(scope, granted)),
  );
}

export function scopesFor(groups: ScopeGroup[]): string[] {
  return [...new Set(groups.flatMap((group) => [...SCOPE_GROUPS[group]]))];
}

/*
 * ===========================================================================
 * READ THIS BEFORE BUILDING THE CLASSROOM INTEGRATION
 * ===========================================================================
 *
 * The constraint is bigger than Classroom, and it is easy to discover far too
 * late -- it does not show up when you test with a personal Gmail account.
 *
 * In Google Workspace for Education, any user the admin has designated as
 * UNDER 18 is blocked from ANY third-party app that the admin has not
 * configured. Not "blocked from Classroom data" -- blocked from the app. That
 * includes plain Sign in with Google. The student sees a "request access"
 * prompt instead of a consent screen, and nothing works until an admin acts.
 *
 * An "unconfigured" app is one with no access setting in the Admin console.
 * An admin must mark ours as one of:
 *   trusted   -- may request any Google data, restricted scopes included
 *   limited   -- unrestricted Google data only
 *   specific  -- only the OAuth scopes the admin lists
 *   blocked   -- cannot sign in at all
 *
 * There is one softener: admins can enable "allow users to access third-party
 * apps that only request basic info needed for Sign in with Google", which lets
 * under-18 students through for name/email/profile without a request. Our
 * identity group above is deliberately exactly that basic set, so sign-in has
 * the best chance of working before any admin involvement. Calendar and
 * Classroom will still require configuration.
 *
 * Errors you will see when this bites:
 *   Error 400: access_not_configured  -- app has no access setting
 *   Error 400: admin_policy_enforced  -- admin has blocked the app
 *
 * Product consequences, which are the reason this comment is long:
 *
 *   1. "Students control their own Google consent" is FALSE for high schoolers
 *      on school-managed accounts. For that segment a school agreement is a
 *      PREREQUISITE, not a growth channel.
 *   2. University students on personal or unmanaged accounts are generally
 *      unaffected, which is why v1 targets university first.
 *   3. Surface access_not_configured / admin_policy_enforced in the UI as
 *      "your school needs to approve Contexto", with something the student
 *      can forward to their admin. Do not show a generic auth error -- the
 *      student cannot fix it themselves and will assume the product is broken.
 *   4. Publish the full scope list for admin review. Workspace Marketplace
 *      guidance expects it, and an admin cannot grant "specific" access without
 *      knowing exactly what to allow.
 *
 * Sources:
 *   https://support.google.com/a/answer/13288950
 *   https://developers.google.com/workspace/classroom/best-practices/access-control-enhancements
 * ===========================================================================
 */
