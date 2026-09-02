import { describe, expect, it } from 'vitest';
import {
  buildProgress,
  buildRunning,
  checkReadiness,
  grantedScopes,
  reportProgress,
  startBuild,
  unreadyReason,
  vaultReadiness,
} from './vault-build.js';

/**
 * Whether there is anything to build a vault out of.
 *
 * The button exists because a vault otherwise appears up to six hours after a
 * student connects their school, with nothing saying it is coming. Pressing it
 * should either start something or say plainly what is missing -- a disabled
 * button with no reason is the worst of both.
 */

const CLASSROOM = 'https://www.googleapis.com/auth/classroom.courses.readonly';
const COURSEWORK = 'https://www.googleapis.com/auth/classroom.coursework.me';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_ALL = 'https://www.googleapis.com/auth/drive.readonly';

describe('whether a vault can be built', () => {
  it('needs Classroom, because everything else hangs off the courses', () => {
    const { ready, missing } = vaultReadiness([GMAIL, DRIVE_ALL], 'lyliu@wearelcc.ca');
    expect(ready).toBe(false);
    expect(missing.join(' ')).toMatch(/classroom/i);
  });

  it('is not ready with Classroom alone', () => {
    /*
     * A vault of coursework alone used to count. It does not any more: a
     * student whose mail or files are missing gets a vault that looks finished
     * and is not, and nobody notices until the agent cannot answer something.
     * Everything needed has to be consented before anything is built.
     */
    const { ready, missing } = vaultReadiness([CLASSROOM, COURSEWORK], 'lyliu@wearelcc.ca');
    expect(ready).toBe(false);
    expect(missing).toEqual(['Gmail', 'Drive']);
  });

  it('is ready once Classroom, Gmail and a whole Drive are all consented', () => {
    const { ready, missing } = vaultReadiness([CLASSROOM, GMAIL, DRIVE_ALL], 'lyliu@wearelcc.ca');
    expect(ready).toBe(true);
    expect(missing).toEqual([]);
  });

  it('is ready on a personal address with Classroom and Drive, since mail cannot apply', () => {
    expect(vaultReadiness([CLASSROOM, DRIVE_ALL], 'someone@gmail.com').ready).toBe(true);
  });

  it('says what is missing rather than only that something is', () => {
    const { missing } = vaultReadiness([CLASSROOM], 'lyliu@wearelcc.ca');
    expect(missing.join(' ')).toMatch(/mail/i);
    expect(missing.join(' ')).toMatch(/drive/i);
  });

  it('counts per-file Drive as not enough to read a Drive', () => {
    /*
     * drive.file grants nothing until the student hands over each file
     * individually, so a vault built on it has no files in it. Reporting that
     * as connected would be a green tick over an empty result.
     */
    const { missing } = vaultReadiness([CLASSROOM, DRIVE_FILE], 'lyliu@wearelcc.ca');
    expect(missing.join(' ')).toMatch(/drive/i);
    expect(
      vaultReadiness([CLASSROOM, DRIVE_ALL], 'lyliu@wearelcc.ca').missing.join(' '),
    ).not.toMatch(/drive/i);
  });

  it('does not ask a student on a personal address for school mail', () => {
    /*
     * There is no school domain to filter by on gmail.com, so the mail import
     * cannot run at all -- and listing it as missing would be telling them to
     * fix something they cannot fix.
     */
    const { missing } = vaultReadiness([CLASSROOM, GMAIL], 'someone@gmail.com');
    expect(missing.join(' ')).not.toMatch(/mail/i);
  });

  it('is not ready with nothing connected, and says so once', () => {
    const { ready, missing } = vaultReadiness([], 'lyliu@wearelcc.ca');
    expect(ready).toBe(false);
    expect(missing.length).toBeGreaterThan(0);
    expect(new Set(missing).size).toBe(missing.length);
  });

  it('reads the stored scope string however Google spaced it', () => {
    expect(grantedScopes(`${CLASSROOM} ${GMAIL},${DRIVE_ALL}`)).toEqual([
      CLASSROOM,
      GMAIL,
      DRIVE_ALL,
    ]);
    expect(grantedScopes(null)).toEqual([]);
    expect(grantedScopes('  ')).toEqual([]);
  });
});

/**
 * Consent on paper is not access.
 *
 * Two testers had every scope stored and a refresh token Google had stopped
 * honouring -- the app is unpublished, so its tokens die after seven days. The
 * build asked Google, got nothing back, and wrote an empty vault with a
 * summary that read like a student with no school. So readiness has to try
 * minting a token, and say "sign in again" when that fails, which is a
 * different fix from "grant Drive".
 */
describe('whether Google still honours the consent', () => {
  const everything = [CLASSROOM, GMAIL, DRIVE_ALL];

  it('does not bother Google when a scope is missing anyway', async () => {
    let minted = 0;
    const readiness = await checkReadiness([CLASSROOM, GMAIL], 'lyliu@wearelcc.ca', async () => {
      minted += 1;
      return 'ya29.token';
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.expired).toBe(false);
    expect(readiness.missing).toEqual(['Drive']);
    expect(minted).toBe(0);
  });

  it('is expired when everything is consented and Google refuses a token', async () => {
    const readiness = await checkReadiness(everything, 'lyliu@wearelcc.ca', async () => null);
    expect(readiness.ready).toBe(false);
    expect(readiness.expired).toBe(true);
    expect(readiness.missing).toEqual([]);
  });

  it('is ready when everything is consented and a token still comes back', async () => {
    const readiness = await checkReadiness(
      everything,
      'lyliu@wearelcc.ca',
      async () => 'ya29.token',
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.expired).toBe(false);
  });
});

describe('saying why a vault will not be built', () => {
  it('tells an expired student to sign in again', () => {
    expect(unreadyReason({ ready: false, missing: [], expired: true })).toMatch(/sign in again/i);
  });

  it('names what has not been consented', () => {
    expect(unreadyReason({ ready: false, missing: ['Gmail', 'Drive'], expired: false })).toBe(
      'Gmail and Drive not consented',
    );
    expect(unreadyReason({ ready: false, missing: ['Drive'], expired: false })).toBe(
      'Drive not consented',
    );
  });

  it('has nothing to say about a student who is ready', () => {
    expect(unreadyReason({ ready: true, missing: [], expired: false })).toBe('');
  });
});

describe('not building the same vault twice at once', () => {
  it('refuses a second start while the first is running', async () => {
    /*
     * A build is minutes of work and costs a model call per message. Two of
     * them racing would pay twice and interleave writes to the same notes, and
     * a student who clicks a button that appears to do nothing will click it
     * again.
     */
    const started = startBuild('alice', async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 'done';
    });
    expect(started).toBe(true);
    expect(buildRunning('alice')).toBe(true);
    expect(startBuild('alice', async () => 'again')).toBe(false);

    // Another student is unaffected.
    expect(startBuild('bob', async () => 'bob')).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(buildRunning('alice')).toBe(false);
  });

  it('lets a build be started again after one fails', async () => {
    startBuild('carol', async () => {
      throw new Error('token expired');
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(buildRunning('carol')).toBe(false);
    expect(startBuild('carol', async () => 'ok')).toBe(true);
  });
});

describe('what a build says about itself', () => {
  it('reports the phase and how far through it is', () => {
    startBuild('dave', async () => new Promise(() => {}));
    reportProgress('dave', { phase: 'files', done: 340, total: 1810 });

    const at = buildProgress('dave');
    expect(at?.phase).toBe('files');
    expect(at?.done).toBe(340);
    expect(at?.total).toBe(1810);
  });

  it('starts at the first phase rather than at nothing', () => {
    /*
     * A student presses the button and polls two seconds later. If progress
     * only exists once a phase has finished, they see a spinner and no phase
     * for the first minute of a two-hour job.
     */
    startBuild('erin', async () => new Promise(() => {}));
    const at = buildProgress('erin');
    expect(at).not.toBeNull();
    expect(at?.phase).toBe('classroom');
    expect(at?.startedAt).toBeGreaterThan(0);
  });

  it('forgets a build once it is over', async () => {
    startBuild('frank', async () => 'done');
    await new Promise((r) => setTimeout(r, 20));
    expect(buildProgress('frank')).toBeNull();
  });

  it('keeps one student progress separate from another', () => {
    startBuild('gina', async () => new Promise(() => {}));
    reportProgress('gina', { phase: 'mail', done: 5, total: 668 });
    expect(buildProgress('gina')?.done).toBe(5);
    expect(buildProgress('helen')).toBeNull();
  });
});
