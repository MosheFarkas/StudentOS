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
export const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events'] as const;

/**
 * Requested only if a student opts into Classroom. Read-only by design: the
 * agent should never be able to submit work on a student's behalf.
 */
export const CLASSROOM_SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
] as const;

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
export function grantedScopeGroups(grantedScope: string | null | undefined): ScopeGroup[] {
  if (!grantedScope) return [];
  const granted = new Set(grantedScope.split(/\s+/).filter(Boolean));

  return (Object.keys(SCOPE_GROUPS) as ScopeGroup[]).filter((group) =>
    SCOPE_GROUPS[group].every((scope) => granted.has(scope)),
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
 *      "your school needs to approve Student OS", with something the student
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
