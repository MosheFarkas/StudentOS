import { domainOf } from '@contexto/agent';

/**
 * Building a student's vault on demand, rather than when the timer next fires.
 *
 * The periodic refresh runs every six hours and does not run on boot, so a
 * student who has just connected their school sees an empty vault for most of
 * a day with nothing saying it is coming. This is the same work, started
 * because somebody asked for it.
 */

const CLASSROOM_COURSES = 'classroom.courses';
const GMAIL_READ = 'gmail.readonly';
const GMAIL_MODIFY = 'gmail.modify';
const DRIVE_ALL = 'drive.readonly';

export interface Readiness {
  /** Whether everything a build needs is consented and still usable. */
  ready: boolean;
  /** What is missing, in the words the settings page uses for it. */
  missing: string[];
  /**
   * Consented on paper, refused in practice: Google no longer honours the
   * refresh token, so the student has to sign in again. An unpublished app
   * gets seven-day tokens, which is how two testers with every scope stored
   * came to have empty vaults built for them without a word of warning.
   */
  expired: boolean;
}

/** The stored scope string, as the list Google actually granted. */
export function grantedScopes(scope: string | null | undefined): string[] {
  return (scope ?? '').split(/[\s,]+/).filter(Boolean);
}

/**
 * What a vault can be built from, given what the student has consented.
 *
 * All of it, or nothing is built. Classroom is where the courses come from,
 * mail is where the people and the announcements come from, and Drive is
 * where the work itself is. A vault missing any of them looks finished and is
 * not, and nobody notices until the agent cannot answer something it should.
 */
export function vaultReadiness(scopes: readonly string[], email: string): Readiness {
  const has = (needle: string) => scopes.some((scope) => scope.includes(needle));
  const missing: string[] = [];

  if (!has(CLASSROOM_COURSES)) missing.push('Classroom');

  /*
   * Only worth asking for on a school address. A student on gmail.com has no
   * school domain to filter by, so the mail import cannot run whatever they
   * connect -- and listing it would be telling them to fix the unfixable.
   */
  if (domainOf(email) && !has(GMAIL_READ) && !has(GMAIL_MODIFY)) missing.push('Gmail');

  /*
   * drive.file specifically does not count. It grants nothing until the
   * student hands over each file through the picker, so a vault built on it
   * has no files in it, and a tick beside "Drive" would be a tick over an
   * empty result.
   */
  if (!has(DRIVE_ALL)) missing.push('Drive');

  return { ready: missing.length === 0, missing, expired: false };
}

/**
 * Readiness that also asks Google.
 *
 * `mint` should try for an access token the way the build will, resolving
 * null when Google refuses. It is only tried once every scope is there: a
 * student who has not consented to Drive is not ready whatever Google says,
 * and asking would be a network call to learn nothing.
 */
export async function checkReadiness(
  scopes: readonly string[],
  email: string,
  mint: () => Promise<string | null>,
): Promise<Readiness> {
  const onPaper = vaultReadiness(scopes, email);
  if (!onPaper.ready) return onPaper;
  if (!(await mint())) return { ready: false, missing: [], expired: true };
  return onPaper;
}

/** Why a vault will not be built, for a log line or a script. Empty when it will. */
export function unreadyReason(readiness: Readiness): string {
  if (readiness.expired) return 'Google access expired, sign in again';
  if (readiness.missing.length === 0) return '';
  const missing = readiness.missing;
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `${list} not consented`;
}

/**
 * Which students have a build running, so a second click cannot start a second.
 *
 * In memory, and deliberately: a build is bounded by this process, and a
 * restart is exactly when the lock should be gone. It costs a model call per
 * message, so two racing would pay twice and interleave writes to the same
 * notes -- and a student whose button appears to do nothing will press it
 * again.
 */
const building = new Map<string, Progress>();

/**
 * What a build is doing right now.
 *
 * The phases are wildly uneven and it matters that a student can tell them
 * apart: on a real account the structure takes twenty seconds, the mail eight
 * minutes, and the files two hours. A single spinner over all three says the
 * same thing at second ten and at hour two.
 */
export type BuildPhase = 'classroom' | 'drive' | 'mail' | 'files' | 'classes';

export interface Progress {
  phase: BuildPhase;
  /** Items finished in this phase, and how many there are. */
  done: number;
  total: number;
  /** When the build began, so a rate and a finish time can be worked out. */
  startedAt: number;
}

export function buildRunning(userId: string): boolean {
  return building.has(userId);
}

/** How far along a student's build is, or null when none is running. */
export function buildProgress(userId: string): Progress | null {
  return building.get(userId) ?? null;
}

/** Called by each phase as it goes. Ignored if the build has already ended. */
export function reportProgress(
  userId: string,
  at: Pick<Progress, 'phase' | 'done' | 'total'>,
): void {
  const current = building.get(userId);
  if (!current) return;
  building.set(userId, { ...at, startedAt: current.startedAt });
}

/**
 * Start a build unless one is already going.
 *
 * @returns false when one was already running, so the caller can say so
 *   rather than silently doing nothing.
 */
export function startBuild(userId: string, work: () => Promise<string>): boolean {
  if (building.has(userId)) return false;

  /*
   * Recorded as started before any work happens.
   *
   * A student presses the button and polls two seconds later. If progress only
   * appeared once a phase had finished, they would see a spinner and no phase
   * at all through the first minute of a two-hour job.
   */
  building.set(userId, { phase: 'classroom', done: 0, total: 0, startedAt: Date.now() });

  void work()
    .then((summary) => {
      console.log(`Vault built for ${userId}: ${summary}`);
    })
    .catch((error: unknown) => {
      // A failure must clear the flag, or one expired token locks a student
      // out of ever building again until the process restarts.
      console.error(`Vault build failed for ${userId}`, error);
    })
    .finally(() => {
      building.delete(userId);
    });

  return true;
}
