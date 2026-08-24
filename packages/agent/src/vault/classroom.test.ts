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
  announcements: [],
  materials: [],
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

  it('makes a note for a file a teacher attached', async () => {
    /*
     * The files were being written into the body as `Attached: <title>` --
     * dead text naming something the agent could not open, link to, or find
     * again. Every attachment carries a Drive id, so this costs nothing and is
     * the difference between knowing a reading exists and knowing which
     * assignment it belongs to.
     */
    await importClassroom(
      vault,
      snapshot({
        materials: [
          {
            id: 'm1',
            course: 'Chemistry',
            title: 'Titration week',
            attachments: [
              {
                kind: 'file',
                title: 'Titration method.pdf',
                fileId: 'drive-1',
                url: 'https://drive/1',
              },
            ],
          },
        ],
      }),
    );

    const file = await vault.read('entity', 'titration-method-pdf');
    expect(file?.description).toBe('File');
    expect(file?.externalId).toBe('drive-1');
    expect(file?.sourceUrl).toBe('https://drive/1');
    expect(file?.body).toContain('[[chemistry]]');

    // And the material points at it, so the edge exists in both directions.
    const material = await vault.read('entity', 'titration-week');
    expect(material?.body).toContain('[[titration-method-pdf]]');
  });

  it('collects the files attached to an assignment', async () => {
    // Where the actual homework lives. The assignment shape was dropping them
    // entirely, so no amount of importing would have found them.
    await importClassroom(
      vault,
      snapshot({
        coursework: [
          {
            id: 'w1',
            course: 'Chemistry',
            title: 'Lab writeup',
            due: null,
            attachments: [{ kind: 'file', title: 'Writeup template', fileId: 'drive-2' }],
          },
        ],
      }),
    );

    expect((await vault.read('entity', 'writeup-template'))?.externalId).toBe('drive-2');
    expect((await vault.read('entity', 'lab-writeup'))?.body).toContain('[[writeup-template]]');
  });

  it('does not make a note for a link or a video', async () => {
    // Only a Drive file is a thing the agent can later open and read. A
    // YouTube link is a URL, and a note for it would be a node with a title
    // and nothing behind it.
    await importClassroom(
      vault,
      snapshot({
        materials: [
          {
            id: 'm1',
            course: 'Chemistry',
            title: 'Watch this',
            attachments: [{ kind: 'video', title: 'Titration explained', url: 'https://yt/1' }],
          },
        ],
      }),
    );

    const files = (await vault.list('entity')).filter((n) => n.description === 'File');
    expect(files).toHaveLength(0);
  });

  it('does not wipe what another pass has added to a note', async () => {
    /*
     * A re-import rebuilds each note's body from Classroom and writes it, and
     * that threw away everything any other pass had appended. Observed on a
     * real vault: 723 files carried a summary of their own contents, an
     * import ran, and 127 were left. Six hundred model calls, already paid
     * for, gone -- and nothing said so, because from the importer's side it
     * was simply an update.
     *
     * The rule that fixes it is a contract about the body: the importer owns
     * everything above the first `## ` heading, and everything from that
     * heading down belongs to whoever put it there.
     */
    const first = snapshot({
      materials: [{ id: 'm1', course: 'Chemistry', title: 'Titration week', attachments: [] }],
    });
    await importClassroom(vault, first);

    const note = await vault.read('entity', 'titration-week');
    await vault.write({
      ...note!,
      body: `${note!.body}\n\n## What is in it (worksheet)\n\nStep by step titration method.`,
    });

    // The same import again, with the title changed so the note must be
    // rewritten rather than skipped as identical.
    await importClassroom(
      vault,
      snapshot({
        materials: [
          { id: 'm1', course: 'Chemistry', title: 'Titration week (updated)', attachments: [] },
        ],
      }),
    );

    const after = await vault.read('entity', 'titration-week');
    expect(after?.body).toContain('Step by step titration method.');
    expect(after?.body).toContain('Titration week (updated)');
  });

  it('records an announcement as something that happened', async () => {
    /*
     * Two hundred and fifty-seven of these existed on a real account and none
     * were imported. They were left out of stage one because they are prose a
     * teacher wrote and there was nowhere safe to put it -- and then the trust
     * boundary shipped and nobody came back for them.
     */
    await importClassroom(
      vault,
      snapshot({
        announcements: [
          {
            id: 'a1',
            course: 'Chemistry',
            text: 'Remember the titration writeup is due before half term.',
            postedAt: '2026-09-02T10:00:00Z',
            attachments: [],
          },
        ],
      }),
    );

    const episodes = await vault.list('episode');
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.event).toBe('announcement');
    expect(episodes[0]?.source).toBe('classroom');
    expect(episodes[0]?.occurred).toBe('2026-09-02T10:00:00.000Z');
    expect(episodes[0]?.body).toContain('half term');
    expect(episodes[0]?.body).toContain('In [[chemistry]]');
  });

  it('records a material as a thing that persists', async () => {
    // A reading or a slide deck is not an event -- it sits there being useful
    // all term -- so it is an entity, like the assignment it supports.
    await importClassroom(
      vault,
      snapshot({
        materials: [
          { id: 'm1', course: 'Chemistry', title: 'Titration technique video', attachments: [] },
        ],
      }),
    );

    const note = await vault.read('entity', 'titration-technique-video');
    expect(note?.description).toBe('Material');
    expect(note?.body).toContain('Part of [[chemistry]]');
  });

  it('does not import the same announcement twice', async () => {
    const withOne = snapshot({
      announcements: [
        {
          id: 'a1',
          course: 'Chemistry',
          text: 'Same notice.',
          postedAt: '2026-09-02T10:00:00Z',
          attachments: [],
        },
      ],
    });
    await importClassroom(vault, withOne);
    await importClassroom(vault, withOne);
    expect(await vault.list('episode')).toHaveLength(1);
  });

  it('keeps announcements apart when Classroom sends no id', async () => {
    /*
     * The tool defaults a missing id to an empty string, and every note here is
     * saved under its external id. Two announcements sharing one id are one
     * file -- so an outage in a field nobody looks at would silently collapse
     * a term of notices into the last one received.
     */
    await importClassroom(
      vault,
      snapshot({
        announcements: [
          {
            id: '',
            course: 'Chemistry',
            text: 'First notice.',
            postedAt: '2026-09-01T10:00:00Z',
            attachments: [],
          },
          {
            id: '',
            course: 'Chemistry',
            text: 'Second notice.',
            postedAt: '2026-09-08T10:00:00Z',
            attachments: [],
          },
        ],
      }),
    );

    expect(await vault.list('episode')).toHaveLength(2);
  });

  it('marks everything it writes as coming from Classroom', async () => {
    /*
     * Announcements and materials carry words a teacher wrote. They are safe
     * to import now only because a note records its source and anything not
     * written by the student is rendered inside a warning -- so getting this
     * field right is what makes the rest of it allowed.
     */
    await importClassroom(
      vault,
      snapshot({
        announcements: [
          {
            id: 'a1',
            course: 'Chemistry',
            text: 'A notice.',
            postedAt: '2026-09-02T10:00:00Z',
            attachments: [],
          },
        ],
        materials: [{ id: 'm1', course: 'Chemistry', title: 'A reading', attachments: [] }],
      }),
    );

    for (const note of [...(await vault.list('entity')), ...(await vault.list('episode'))]) {
      expect(note.source).toBe('classroom');
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
