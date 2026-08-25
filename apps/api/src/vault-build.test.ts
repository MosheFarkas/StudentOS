import { describe, expect, it } from 'vitest';
import {
  buildProgress,
  buildRunning,
  reportProgress,
  startBuild,
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

  it('is ready with Classroom alone', () => {
    // Mail and files make it richer. Courses make it exist.
    expect(vaultReadiness([CLASSROOM, COURSEWORK], 'lyliu@wearelcc.ca').ready).toBe(true);
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
