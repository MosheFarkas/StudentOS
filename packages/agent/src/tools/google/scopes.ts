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
  /**
   * Requested ONLY when the student explicitly asks for them.
   *
   * Distinct from optional, which is always requested and merely tolerated
   * when refused. Elective scopes are ones where the broader grant is a real
   * decision with a cost -- so putting them on a consent screen the student
   * did not ask for would be taking that decision for them.
   */
  readonly elective?: readonly string[];
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

/**
 * Turn work in, take it back, attach files to a submission.
 *
 * The write counterpart of coursework.me.readonly, and elective rather than
 * requested by default -- see the note at the bottom of this file on what it
 * means to let an agent submit work under a student's name.
 */
export const CLASSROOM_COURSEWORK_WRITE_SCOPE =
  'https://www.googleapis.com/auth/classroom.coursework.me';

/**
 * Per-file Drive access.
 *
 * NON-SENSITIVE -- the lightest tier Google has, needing only basic OAuth
 * verification. It grants nothing on its own: the app can read a file only
 * once the student has explicitly handed that file over through the Google
 * Picker.
 *
 * That is why this scope and not drive.readonly. See the note at the bottom
 * of this file.
 */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Read every file in the student's Drive, Classroom materials included.
 *
 * RESTRICTED. What that costs depends entirely on who is using the app, and
 * the two cases are far apart:
 *
 *   Personal use -- you, or a handful of people you know personally. Google
 *   lists this as an explicit EXCEPTION to verification. No review, no
 *   security assessment. There is a user cap, an "unverified app" warning on
 *   the consent screen, and a shorter refresh-token lifetime.
 *
 *   Public launch -- restricted-scope verification, plus a CASA security
 *   assessment because we transmit file text to an LLM, redone every 12
 *   months.
 *
 * So this is offered, not requested by default. A student who wants their
 * agent to read everything can say so; the per-file grant stays the default
 * because it is what survives contact with a school admin.
 */
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export type ScopeGroup = 'identity' | 'calendar' | 'classroom' | 'drive';

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
    elective: [CLASSROOM_COURSEWORK_WRITE_SCOPE],
  },

  /**
   * Reading the contents of files the student hands over.
   *
   * Granting this scope alone lets the agent read NOTHING. Access is per file
   * and is granted by the student picking that file, which is what makes the
   * scope non-sensitive. The connection being green therefore means "ready to
   * be given files", not "can read your Drive" -- the UI has to say so.
   */
  drive: {
    required: [DRIVE_FILE_SCOPE],
    optional: [],
    elective: [DRIVE_READONLY_SCOPE],
  },
};

/** Every elective scope across all groups. */
export const ELECTIVE_SCOPES: readonly string[] = Object.values(SCOPE_GROUPS).flatMap(
  (group) => group.elective ?? [],
);

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
  // Reading everything covers reading a picked file. A student who granted
  // full Drive access must not be told Drive is disconnected.
  [DRIVE_FILE_SCOPE]: [DRIVE_READONLY_SCOPE],

  /*
   * MEASURED, not inferred from the docs. On a real school account holding
   * student-submissions.me.readonly and NOT coursework.me.readonly,
   * courses.courseWork.list returns 188 assignments with titles and due
   * dates. Which makes sense -- a submission is meaningless without the
   * assignment it belongs to.
   *
   * This mattered: gating the assignments tool on coursework.me.readonly
   * alone withheld it from a student who could read assignments perfectly
   * well, and produced advice to go and ask a school administrator for a
   * permission they did not need. Under-registering hides a working feature
   * completely; over-registering costs one wasted turn, and the tool reports
   * unavailability cleanly if this ever stops holding.
   */
  [CLASSROOM_COURSEWORK_SCOPE]: [CLASSROOM_SUBMISSIONS_SCOPE],
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

/**
 * Everything to request for these groups: required plus optional, plus any
 * elective scopes named in `elective`.
 *
 * Callers must pass elective scopes the student ALREADY holds, not just newly
 * chosen ones. Google issues a token carrying exactly what was asked for, so
 * omitting a held elective scope silently downgrades it the next time the
 * student connects anything -- the same failure the union rule in
 * routes/google.ts exists to prevent, one level down.
 */
export function scopesFor(groups: ScopeGroup[], elective: readonly string[] = []): string[] {
  const allowed = new Set(ELECTIVE_SCOPES);
  return [
    ...new Set([
      ...groups.flatMap((group) => [
        ...SCOPE_GROUPS[group].required,
        ...SCOPE_GROUPS[group].optional,
      ]),
      ...elective.filter((scope) => allowed.has(scope)),
    ]),
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
 *
 * ===========================================================================
 * WHY DRIVE IS PER-FILE (drive.file) AND NOT drive.readonly
 * ===========================================================================
 *
 * drive.readonly is RESTRICTED. Google's own qualification text is explicit
 * that storing or transmitting restricted-scope data off the device triggers a
 * security assessment, and we necessarily transmit file text to an LLM. That
 * assessment recurs ANNUALLY. drive.file is non-sensitive: basic verification,
 * no assessment, no recurring cost. Google's Drive scope guide now recommends
 * migrating restricted-scope apps to it.
 *
 * The tradeoff is real and worth naming: drive.file means the agent can only
 * read what the student has handed it through the Picker. It cannot go looking.
 * For a product used by minors, being structurally unable to read a student's
 * whole Drive is a feature -- it is the difference between "reads the exam
 * review you gave it" and "has your entire Drive".
 *
 * If broad access is ever wanted, Contexto DOES qualify to apply, under the
 * "Productivity and education" category. Only the scope constant and the
 * Picker gate would change; the extraction pipeline is identical.
 *
 * Source: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
 * ===========================================================================
 */
