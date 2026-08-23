import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from './vault.js';
import { importClassroom, type ClassroomSnapshot } from './classroom.js';

/**
 * Mapping Classroom into ContextoVault.
 *
 * The first half of the bootstrap, and the cheap half: courses, coursework,
 * topics and submissions arrive as objects with stable ids, so turning them
 * into linked notes is a data transformation with no model in it. Nothing here
 * reads a teacher's prose, which is why it can be built before the trust
 * boundary rather than after it.
 */

const snapshot = (over: Partial<ClassroomSnapshot> = {}): ClassroomSnapshot => ({
  courses: [{ id: 'c-1', name: 'Chemistry' }],
  coursework: [{ id: 'w-1', course: 'Chemistry', title: 'Titration writeup', due: '2026-09-14' }],
  topics: [],
  submissions: [],
  ...over,
});

describe('importing a snapshot', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-classroom-'));
    vault = new Vault(root, 'agent-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('makes a note per course, keyed by its Classroom id', async () => {
    await importClassroom(vault, snapshot());
    const course = await vault.read('entity', 'chemistry');

    expect(course?.externalId).toBe('c-1');
    expect(course?.source).toBe('classroom');
  });

  it('makes a note per assignment and links it to its course', async () => {
    await importClassroom(vault, snapshot());
    const work = await vault.read('entity', 'titration-writeup');

    expect(work?.externalId).toBe('w-1');
    expect(work?.body).toContain('[[chemistry]]');
    expect(work?.body).toContain('2026-09-14');
  });

  it('writes what is submitted onto the assignment', async () => {
    await importClassroom(
      vault,
      snapshot({
        submissions: [
          {
            course: 'Chemistry',
            assignment: 'Titration writeup',
            // What the tool actually returns -- SUBMISSION_STATES maps the raw
            // Classroom enum to words before this ever reaches the vault.
            state: 'turned in',
            late: true,
            grade: 18,
            maxPoints: 20,
            submissionId: 's-1',
            courseId: 'c-1',
            courseWorkId: 'w-1',
          },
        ],
      }),
    );

    const work = await vault.read('entity', 'titration-writeup');
    expect(work?.body).toContain('18');
    expect(work?.body.toLowerCase()).toContain('late');
    expect(work?.body).toContain('Turned in');
  });

  it('makes a note per topic, linked to its course', async () => {
    await importClassroom(
      vault,
      snapshot({ topics: [{ course: 'Chemistry', name: 'Organic', topicId: 't-1' }] }),
    );

    const topic = await vault.read('entity', 'organic');
    expect(topic?.externalId).toBe('t-1');
    expect(topic?.body).toContain('[[chemistry]]');
  });

  it('links an assignment to its topic as well as its course', async () => {
    /*
     * The edge that makes the vault a graph rather than a star.
     *
     * Measured on a real account: 236 notes, twelve of which had any inbound
     * link at all, because assignments pointed at courses and nothing pointed
     * at anything else. Sixty-eight topic notes had none, which made them dead
     * weight. Classroom returns topicId on coursework and the tool layer was
     * dropping it.
     */
    await importClassroom(
      vault,
      snapshot({
        topics: [{ course: 'Chemistry', name: 'Organic', topicId: 't-1' }],
        coursework: [
          {
            id: 'w-1',
            course: 'Chemistry',
            title: 'Titration writeup',
            due: '2026-09-14',
            topicId: 't-1',
          },
        ],
      }),
    );

    const work = await vault.read('entity', 'titration-writeup');
    expect(work?.body).toContain('[[chemistry]]');
    expect(work?.body).toContain('[[organic]]');
  });

  it('still works for an assignment filed under no topic', async () => {
    await importClassroom(vault, snapshot());
    expect((await vault.read('entity', 'titration-writeup'))?.body).toContain('[[chemistry]]');
  });

  it('imports no prose written by a teacher', async () => {
    /*
     * Stage one deliberately maps structure and nothing else. Descriptions and
     * announcements are written by other people, and until imported notes are
     * rendered inside the warning the tools already use, none of that belongs
     * in a file the agent will later read.
     */
    await importClassroom(vault, snapshot());
    const notes = await vault.list('entity');
    for (const note of notes) {
      expect(note.body.length).toBeLessThan(400);
    }
  });
});

describe('running it again', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-classroom-'));
    vault = new Vault(root, 'agent-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('changes nothing when nothing changed', async () => {
    await importClassroom(vault, snapshot());
    const second = await importClassroom(vault, snapshot());

    expect(second.updated).toBe(0);
    expect(await vault.list('entity')).toHaveLength(2);
  });

  it('updates a moved deadline in place and remembers the old one', async () => {
    // Classroom shows the deadline as it is now. What it cannot show is that
    // it moved, which is the whole reason to keep a copy.
    await importClassroom(vault, snapshot());
    await importClassroom(
      vault,
      snapshot({
        coursework: [
          { id: 'w-1', course: 'Chemistry', title: 'Titration writeup', due: '2026-09-21' },
        ],
      }),
    );

    const work = await vault.read('entity', 'titration-writeup');
    expect(work?.body).toContain('2026-09-21');
    expect(work?.body).toContain('2026-09-14');
    expect(await vault.list('entity')).toHaveLength(2);
  });

  it('follows a renamed assignment rather than duplicating it', async () => {
    // The id is the identity. Matching on the title would leave the old note
    // behind as a second, stale piece of coursework.
    await importClassroom(vault, snapshot());
    await importClassroom(
      vault,
      snapshot({
        coursework: [
          { id: 'w-1', course: 'Chemistry', title: 'Titration write-up (v2)', due: '2026-09-14' },
        ],
      }),
    );

    const work = await vault.list('entity');
    expect(work.filter((n) => n.externalId === 'w-1')).toHaveLength(1);
  });

  it('keeps two courses with the same name apart', async () => {
    /*
     * Two sections of the same subject share a name, and the tool layer hands
     * over the name rather than the id for coursework. Slugging alone would
     * merge them into one note and silently lose a course.
     */
    await importClassroom(
      vault,
      snapshot({
        courses: [
          { id: 'c-1', name: 'Chemistry' },
          { id: 'c-2', name: 'Chemistry' },
        ],
      }),
    );

    const courses = (await vault.list('entity')).filter((n) => n.description === 'Course');
    expect(courses).toHaveLength(2);
    expect(new Set(courses.map((c) => c.externalId)).size).toBe(2);
  });
});
