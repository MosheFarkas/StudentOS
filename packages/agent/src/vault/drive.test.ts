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

const file = (over: Partial<DriveFile> = {}): DriveFile => ({
  fileId: 'd1',
  name: 'Grade 10 History Outline 2025',
  mimeType: 'application/vnd.google-apps.document',
  ownedByStudent: true,
  ...over,
});

describe("importing the student's Drive", () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-drive-'));
    vault = new Vault(root, 'student-1');
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
    expect(await vault.list('entity')).toHaveLength(0);
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
    expect(await vault.list('entity')).toHaveLength(1);
  });
});
