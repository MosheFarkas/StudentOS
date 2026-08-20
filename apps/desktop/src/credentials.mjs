import { execFileSync } from 'node:child_process';

/**
 * Site sign-ins, kept in the login keychain.
 *
 * Deliberately NOT on the server and NOT in config.json. This is a student's
 * actual school password, often a minor's, and often the same password they
 * use elsewhere. Holding it centrally would mean one breach of our database
 * exposed school accounts belonging to people who never chose that risk. The
 * keychain is encrypted at rest, unlocked by their own login, and is where
 * macOS expects a credential to live -- so the blast radius of losing this
 * laptop is the same with us as without us.
 *
 * The server never sees these. It receives pages, never the means to fetch
 * them.
 */

const SERVICE = (portalId) => `ContextoAgent: ${portalId}`;

/** macOS only. Elsewhere the app simply does not offer to remember a sign-in. */
export function keychainAvailable() {
  return process.platform === 'darwin';
}

export function saveCredentials(portalId, { username, password }) {
  if (!keychainAvailable()) throw new Error('Saved sign-ins need the macOS keychain.');
  if (!username || !password) throw new Error('Both a username and a password are needed.');
  /*
   * The password goes through argv. On macOS a process's arguments are
   * readable only by its own user, so this is the same audience that can
   * already read the keychain once it is unlocked -- but it is worth knowing
   * that it is momentarily there rather than assuming otherwise.
   */
  execFileSync(
    'security',
    ['add-generic-password', '-a', username, '-s', SERVICE(portalId), '-w', password, '-U'],
    { stdio: 'ignore' },
  );
  return { username };
}

/** @returns {{ username: string, password: string } | null} */
export function readCredentials(portalId) {
  if (!keychainAvailable()) return null;
  try {
    const password = execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE(portalId), '-w'],
      // stderr silenced: "item could not be found" is the normal answer for a
      // site with no saved sign-in, and printing it makes a routine state look
      // like a fault.
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).replace(/\n$/, '');
    const dump = execFileSync('security', ['find-generic-password', '-s', SERVICE(portalId)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const username = /"acct"<blob>="([^"]*)"/.exec(dump)?.[1] ?? '';
    return password ? { username, password } : null;
  } catch {
    // No entry, or the student declined the keychain prompt. Both mean "no
    // saved sign-in", which is a normal state rather than a failure.
    return null;
  }
}

/** Whether a sign-in is remembered, without unlocking it. */
export function hasCredentials(portalId) {
  if (!keychainAvailable()) return false;
  try {
    execFileSync('security', ['find-generic-password', '-s', SERVICE(portalId)], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function clearCredentials(portalId) {
  if (!keychainAvailable()) return false;
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE(portalId)], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
