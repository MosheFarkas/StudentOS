/**
 * Google OAuth scope groups.
 *
 * Requested as SEPARATE consents, never bundled into sign-in. A student signs
 * in first and is asked for Calendar (and later Classroom) only when they
 * choose to connect it.
 *
 * Each group separates REQUIRED scopes from OPTIONAL ones, and that split is
 * load-bearing rather than tidy. School Workspace admins grant scope subsets as
 * a matter of routine -- "specific Google data" is a first-class option in the
 * Admin console. An all-or-nothing rule means every scope we add makes the
 * connection MORE likely to fail, and a student whose admin approved five of
 * six scopes would see a completely dead integration rather than a slightly
 * reduced one.
 *
 * So: required scopes decide whether the group is connected at all. Optional
 * scopes enable individual tools, and their absence removes only those tools.
 */

export interface ScopeGroupDefinition {
  /** Without every one of these, the group is not connected. */
  readonly required: readonly string[];
  /** Enhance the group. Absent ones disable specific tools, nothing more. */
  readonly optional: readonly string[];
}

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export const CLASSROOM_COURSES_SCOPE = 'https://www.googleapis.com/auth/classroom.courses.readonly';
export const CLASSROOM_COURSEWORK_SCOPE =
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly';
export const CLASSROOM_SUBMISSIONS_SCOPE =
  'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly';
export const CLASSROOM_ANNOUNCEMENTS_SCOPE =
  'https://www.googleapis.com/auth/classroom.announcements.readonly';
export const CLASSROOM_TOPICS_SCOPE = 'https://www.googleapis.com/auth/classroom.topics.readonly';
export const CLASSROOM_MATERIALS_SCOPE =
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly';

export type ScopeGroup = 'identity' | 'calendar' | 'classroom';

export const SCOPE_GROUPS: Record<ScopeGroup, ScopeGroupDefinition> = {
  /** Always requested. The minimum to create an account and nothing more. */
  identity: {
    required: [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    optional: [],
  },

  /**
   * Full calendar access -- read, create, update, delete events, and manage
   * calendars. Still a SENSITIVE scope, the same review tier as the narrower
   * calendar.events, so the broader grant costs nothing extra in verification.
   * No Calendar scope is restricted.
   */
  calendar: {
    required: [CALENDAR_SCOPE],
    optional: [],
  },

  /**
   * Read-only, and deliberately so -- see the note at the bottom of this file.
   *
   * Only the course list is required: without it there is nothing to hang
   * anything else off. Everything else is optional, so a school that approves
   * a subset still gets a working integration.
   */
  classroom: {
    required: [CLASSROOM_COURSES_SCOPE],
    optional: [
      CLASSROOM_COURSEWORK_SCOPE,
      CLASSROOM_SUBMISSIONS_SCOPE,
      CLASSROOM_ANNOUNCEMENTS_SCOPE,
      CLASSROOM_TOPICS_SCOPE,
      CLASSROOM_MATERIALS_SCOPE,
    ],
  },
};

/**
 * Narrower scopes that still satisfy a broader requirement.
 *
 * Google's scopes are hierarchical, and widening what we REQUEST must not
 * disconnect students who already granted something sufficient. Someone who
 * connected before we asked for full calendar access holds calendar.events,
 * which covers every event tool we ship. Reconnecting upgrades them; it is
 * not required.
 */
const ALSO_SATISFIED_BY: Record<string, readonly string[]> = {
  [CALENDAR_SCOPE]: [CALENDAR_EVENTS_SCOPE],
};

/**
 * Parse the granted-scope string into a set.
 *
 * Splits on commas AND whitespace: Google returns scopes space-separated, but
 * Better Auth normalises them to commas before storing. Splitting on only one
 * turns the whole value into a single token, and every integration silently
 * reports disconnected with the grant intact in the same row.
 */
export function parseGrantedScopes(grantedScope: string | null | undefined): Set<string> {
  if (!grantedScope) return new Set();
  return new Set(grantedScope.split(/[\s,]+/).filter(Boolean));
}

/** True if `scope` is granted directly, or covered by a broader scope. */
export function hasScope(scope: string, granted: Set<string>): boolean {
  if (granted.has(scope)) return true;
  return (ALSO_SATISFIED_BY[scope] ?? []).some((alternative) => granted.has(alternative));
}

/** Groups whose REQUIRED scopes are all present. */
export function grantedScopeGroups(grantedScope: string | null | undefined): ScopeGroup[] {
  const granted = parseGrantedScopes(grantedScope);

  return (Object.keys(SCOPE_GROUPS) as ScopeGroup[]).filter((group) =>
    SCOPE_GROUPS[group].required.every((scope) => hasScope(scope, granted)),
  );
}

/**
 * Optional scopes a group is missing.
 *
 * Surfaced so a student can be told which capabilities their school withheld,
 * rather than discovering it as a tool that silently never fires.
 */
export function missingOptionalScopes(
  group: ScopeGroup,
  grantedScope: string | null | undefined,
): string[] {
  const granted = parseGrantedScopes(grantedScope);
  return SCOPE_GROUPS[group].optional.filter((scope) => !hasScope(scope, granted));
}

/** Everything to request for these groups: required plus optional. */
export function scopesFor(groups: ScopeGroup[]): string[] {
  return [
    ...new Set(
      groups.flatMap((group) => [...SCOPE_GROUPS[group].required, ...SCOPE_GROUPS[group].optional]),
    ),
  ];
}

/*
 * ===========================================================================
 * WHY CLASSROOM IS READ-ONLY
 * ===========================================================================
 *
 * COST. Classroom write scopes (submitting coursework, modifying courses) and
 * roster/profile scopes are RESTRICTED, not sensitive. Restricted scopes
 * require a CASA security assessment that must be REDONE ANNUALLY -- an
 * ongoing cost and review cycle, not a one-time hurdle. Every scope above is
 * sensitive, the same tier as Calendar, and adds no new review burden.
 *
 * ADMIN APPROVAL. School admins grant specific scope lists. A read-only
 * request is a far easier yes than one that can submit work, and admin
 * approval gates the entire under-18 segment.
 *
 * ACADEMIC INTEGRITY. An agent that can turn in coursework can turn in the
 * wrong thing, at the wrong time, under a student's name.
 *
 * ===========================================================================
 * READ THIS BEFORE BUILDING ANY CLASSROOM FEATURE
 * ===========================================================================
 *
 * In Google Workspace for Education, any user designated as UNDER 18 is
 * blocked from ANY third-party app the admin has not configured. Not "blocked
 * from Classroom data" -- blocked from the app, including plain Sign in with
 * Google. They see a "request access" prompt instead of a consent screen.
 *
 * An admin must mark the app trusted / limited / specific-scopes / blocked.
 * Errors when this bites: access_not_configured, admin_policy_enforced.
 *
 * Consequences:
 *   1. "Students control their own Google consent" is FALSE for high
 *      schoolers on managed accounts. A school agreement is a PREREQUISITE
 *      for that segment, not a growth channel.
 *   2. University students on personal accounts are generally unaffected,
 *      which is why v1 targets university.
 *   3. Partial grants are NORMAL, not exceptional -- hence the required /
 *      optional split above.
 *
 * Sources:
 *   https://support.google.com/a/answer/13288950
 *   https://developers.google.com/workspace/classroom/best-practices/access-control-enhancements
 * ===========================================================================
 */
