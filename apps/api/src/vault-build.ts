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
  /** Whether there is enough connected to build anything at all. */
  ready: boolean;
  /** What is missing, in the words the settings page uses for it. */
  missing: string[];
}

/**
 * What a vault can be built from, given what the student has connected.
 *
 * Classroom is the only requirement: courses are what everything else hangs
 * off, and without them there is nothing for an email or a file to be about.
 * Mail and Drive are reported as missing rather than blocking, because a vault
 * of coursework alone is worth having and worth saying is thinner than it
 * could be.
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

  return { ready: !missing.includes('Classroom'), missing };
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
const building = new Set<string>();

export function buildRunning(userId: string): boolean {
  return building.has(userId);
}

/**
 * Start a build unless one is already going.
 *
 * @returns false when one was already running, so the caller can say so
 *   rather than silently doing nothing.
 */
export function startBuild(userId: string, work: () => Promise<string>): boolean {
  if (building.has(userId)) return false;
  building.add(userId);

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
