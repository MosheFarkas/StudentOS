import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from './vault.js';
import { importDrive, type DriveFile } from './drive.js';

/**
 * The student's own Drive.
 *
 * Distinct from the files a teacher attached in Classroom, which arrive with a
 * course and an assignment already attached to them. These arrive with almost
 * nothing: measured on a real account, 459 of 469 files resolve to no folder at
 * all, because the app has per-file access rather than a view of the tree. So
 * the folder path -- the obvious way to file them -- carries nothing, and what
 * is left is the name, the owner, and when it was last touched.
 *
 * Which is fine. "ANSWERKEY June Exam Study Guide" and "Liu and Rivard Gr10
 * Major Project" say plenty, and what the file is actually about is settled
 * later by the pass that reads it.
 */

/*
 * Filed under History by default.
 *
 * A file that belongs to no course the student takes is not imported at all
 * now, so every fixture here needs a home -- which is the rule these tests are
 * about rather than an inconvenience they work around.
 */
const file = (over: Partial<DriveFile> = {}): DriveFile => ({
  fileId: 'd1',
  name: 'Grade 10 History Outline 2025',
  mimeType: 'application/vnd.google-apps.document',
  ownedByStudent: true,
  path: ['History'],
  ...over,
});

describe("importing the student's Drive", () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-drive-'));
    vault = new Vault(root, 'student-1');
    await vault.write({
      name: 'history',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'History, on Google Classroom.',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('makes a note for a file, saying where it came from', async () => {
    const result = await importDrive(vault, [file({ link: 'https://drive/d1' })]);

    expect(result.written).toBe(1);
    const note = await vault.read('entity', 'grade-10-history-outline-2025');
    expect(note?.description).toBe('File');
    // Not 'classroom': a file in a student's Drive can be anything, including
    // a copy of something a teacher wrote, and the source is what decides
    // whether a later reader sees it inside the warning.
    expect(note?.source).toBe('drive');
    expect(note?.sourceUrl).toBe('https://drive/d1');
  });

  it('leaves alone a file Classroom already gave us', async () => {
    /*
     * 139 of this account's Drive files are the same files a teacher attached
     * in Classroom. Those notes already know their course and their
     * assignment, and rewriting them from Drive would throw all of that away
     * in exchange for a name.
     */
    await vault.write({
      name: 'titration-method',
      kind: 'entity',
      source: 'classroom',
      description: 'File',
      externalId: 'd1',
      body: 'Titration method.\n\nPart of [[chemistry]].',
    });

    const result = await importDrive(vault, [file({ fileId: 'd1', name: 'Titration method' })]);

    expect(result.skipped).toBe(1);
    expect(result.written).toBe(0);
    expect((await vault.read('entity', 'titration-method'))?.body).toContain('[[chemistry]]');
  });

  it('ignores folders and shortcuts', async () => {
    // A folder is structure, not content, and a shortcut is a second name for
    // a file that is already here.
    const result = await importDrive(vault, [
      file({ fileId: 'f1', name: 'Grade 10 Math', mimeType: 'application/vnd.google-apps.folder' }),
      file({ fileId: 's1', name: 'A pointer', mimeType: 'application/vnd.google-apps.shortcut' }),
    ]);

    expect(result.written).toBe(0);
    expect((await vault.list('entity')).filter((n) => n.description === 'File')).toHaveLength(0);
  });

  it('records whether the student wrote it', async () => {
    // The strongest signal available about whether a file matters to them,
    // now that the folder tree turns out to be invisible.
    await importDrive(vault, [
      file({ fileId: 'mine', name: 'My essay', ownedByStudent: true }),
      file({ fileId: 'theirs', name: 'Shared handout', ownedByStudent: false }),
    ]);

    expect((await vault.read('entity', 'my-essay'))?.body).toContain('Yours');
    expect((await vault.read('entity', 'shared-handout'))?.body).not.toContain('Yours');
  });

  it('files it under a course when the folder happens to be one', async () => {
    // Rare on a real account but free when it happens, and the only edge these
    // files get before anything reads them.
    await vault.write({
      name: 'grade-10-math',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Grade 10 Math.',
    });

    await importDrive(vault, [
      file({ fileId: 'd2', name: 'Unit 3 notes', path: ['Grade 10 Math'] }),
    ]);
    expect((await vault.read('entity', 'unit-3-notes'))?.body).toContain('[[grade-10-math]]');
  });

  it('runs twice without making a second copy of anything', async () => {
    const files = [file()];
    await importDrive(vault, files);
    const again = await importDrive(vault, files);

    expect(again.written).toBe(0);
    expect((await vault.list('entity')).filter((n) => n.description === 'File')).toHaveLength(1);
  });

  it('records who shared a file that is not the student\u2019s own', async () => {
    /*
     * Drive returns the owner's name and address, which is more than Classroom
     * will say about who posted an announcement -- and the field mask never
     * asked for it, so a source of teacher names sat unread beside a thousand
     * files. A worksheet shared into a course is usually shared by whoever
     * teaches it.
     */
    await importDrive(vault, [
      file({
        fileId: 'f-9',
        name: 'Titration rubric.pdf',
        ownedByStudent: false,
        owner: 'Anna Bell',
      }),
    ]);

    const note = await vault.read('entity', 'titration-rubric-pdf');
    expect(note?.body).toContain('Shared by Anna Bell');
  });

  it('says which piece of work inside the course a file belongs to', async () => {
    /*
     * The course alone is not the whole address. "History/Cold War essay/drafts"
     * names the subject and then says which piece of work, which is most of
     * what there is to say about a file called draft3.docx.
     */
    await importDrive(vault, [
      file({ fileId: 'p1', name: 'Draft three', path: ['History', 'Cold War essay', 'drafts'] }),
    ]);

    const note = await vault.read('entity', 'draft-three');
    expect(note?.body).toContain('Part of [[history]]');
    expect(note?.body).toContain('History/Cold War essay/drafts');
  });
});

describe('a file has to belong to a course they still take', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-driverule-'));
    vault = new Vault(root, 'student-1');
    await vault.write({
      name: 'gr10-design',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'GR10 - Design // 2025-26, on Google Classroom.',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** No folder by default: belonging to nothing is the case under test. */
  const loose = (over: Partial<DriveFile>): DriveFile =>
    ({
      fileId: 'f-1',
      name: 'A file',
      mimeType: 'application/vnd.google-apps.document',
      ownedByStudent: true,
      ...over,
    }) as DriveFile;

  const files = async () =>
    (await vault.list('entity')).filter((note) => note.description === 'File');

  it('keeps a file whose folder names a course they take', async () => {
    // "DESIGN 10" and "GR10 - Design // 2025-26" are one subject said twice.
    await importDrive(vault, [loose({ fileId: 'f-1', path: ['DESIGN 10'] })]);
    expect(await files()).toHaveLength(1);
  });

  it('leaves out a file in a folder that names no course', async () => {
    /*
     * Left out rather than brought in and swept.
     *
     * Reading a file is a model call. Importing one and removing it again pays
     * that on every build, for ever, for a file nobody wanted kept.
     */
    await importDrive(vault, [loose({ fileId: 'f-2', path: ['Music', 'loops'] })]);
    expect(await files()).toHaveLength(0);
  });

  it('leaves out a file in no folder at all', async () => {
    await importDrive(vault, [loose({ fileId: 'f-3' })]);
    expect(await files()).toHaveLength(0);
  });

  it('says how many it left out, rather than passing over it in silence', async () => {
    const result = await importDrive(vault, [
      loose({ fileId: 'f-4', path: ['Music'] }),
      loose({ fileId: 'f-5' }),
    ]);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
  });

  it('does not reach across and take a file a teacher attached', async () => {
    // Those come in through the Classroom importer with their own course link.
    await vault.write({
      name: 'handout',
      kind: 'entity',
      source: 'classroom',
      description: 'File',
      body: 'Handout.\nPart of [[gr10-design]].',
    });

    await importDrive(vault, [loose({ fileId: 'f-6' })]);
    expect(await vault.read('entity', 'handout')).not.toBeNull();
  });
});
