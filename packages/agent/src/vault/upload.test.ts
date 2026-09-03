import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vault } from './vault.js';
import { UPLOAD_LIMIT_BYTES, classifyUpload, importUpload, uploadNoteName } from './upload.js';

/**
 * Files a student hands over from their own machine.
 *
 * The point of writing them into the vault rather than into the message is
 * that the vault is the only memory that outlives one conversation. A syllabus
 * uploaded in September is still there in March, and every chat can read it --
 * which is also why an upload has to be idempotent: dragging the same file in
 * twice must leave one note, not two.
 */

const bytes = (text: string) => new TextEncoder().encode(text);

async function emptyVault(): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), 'upload-test-'));
  return new Vault(root, 'student1');
}

describe('deciding what an upload is', () => {
  it('reads a pdf as a pdf, by type or by name', () => {
    expect(classifyUpload({ filename: 'a.pdf', mimeType: 'application/pdf', size: 10 })).toEqual({
      kind: 'pdf',
    });
    // Browsers do not always send a type; the extension is the fallback.
    expect(classifyUpload({ filename: 'a.pdf', mimeType: '', size: 10 })).toEqual({ kind: 'pdf' });
  });

  it('reads plain text, markdown and csv as text', () => {
    for (const [filename, mimeType] of [
      ['notes.txt', 'text/plain'],
      ['notes.md', 'text/markdown'],
      ['grades.csv', 'text/csv'],
      ['notes.md', ''],
    ] as const) {
      expect(classifyUpload({ filename, mimeType, size: 10 })).toEqual({ kind: 'text' });
    }
  });

  it('refuses what it cannot read rather than attaching an empty note', () => {
    expect(classifyUpload({ filename: 'photo.jpg', mimeType: 'image/jpeg', size: 10 })).toEqual({
      refusal: 'unsupported-type',
    });
    expect(classifyUpload({ filename: 'sheet.xlsx', mimeType: '', size: 10 })).toEqual({
      refusal: 'unsupported-type',
    });
  });

  it('refuses a file past the limit before reading any of it', () => {
    expect(
      classifyUpload({
        filename: 'big.pdf',
        mimeType: 'application/pdf',
        size: UPLOAD_LIMIT_BYTES + 1,
      }),
    ).toEqual({ refusal: 'too-large' });
  });

  it('accepts a file exactly at the limit', () => {
    expect(
      classifyUpload({
        filename: 'big.pdf',
        mimeType: 'application/pdf',
        size: UPLOAD_LIMIT_BYTES,
      }),
    ).toEqual({ kind: 'pdf' });
  });

  it('refuses an empty file', () => {
    expect(classifyUpload({ filename: 'a.txt', mimeType: 'text/plain', size: 0 })).toEqual({
      refusal: 'empty',
    });
  });
});

describe('naming the note an upload becomes', () => {
  it('names it after the file, without the extension', () => {
    expect(uploadNoteName('Biology Syllabus.pdf')).toBe('biology-syllabus');
  });

  it('produces a name the vault will accept from a hostile one', () => {
    // The name becomes a path segment. slugForNote is what makes that safe.
    expect(uploadNoteName('../../etc/passwd.txt')).not.toContain('/');
    expect(uploadNoteName('../../etc/passwd.txt')).not.toContain('.');
  });

  it('gives the same file the same name every time, so a re-upload replaces', () => {
    expect(uploadNoteName('Syllabus.pdf')).toBe(uploadNoteName('syllabus.PDF'));
  });
});

describe('importing an upload into the vault', () => {
  it('writes the file’s text where any chat can find it', async () => {
    const vault = await emptyVault();
    const result = await importUpload(vault, {
      filename: 'syllabus.txt',
      mimeType: 'text/plain',
      bytes: bytes('Unit 1 is due on the 14th of October.'),
    });

    expect(result).toEqual({ ok: true, name: 'syllabus' });
    const note = await vault.read('entity', 'syllabus');
    expect(note?.body).toContain('due on the 14th of October');
  });

  it('marks it as something the student handed over', async () => {
    const vault = await emptyVault();
    await importUpload(vault, {
      filename: 'syllabus.txt',
      mimeType: 'text/plain',
      bytes: bytes('Unit 1.'),
    });

    const note = await vault.read('entity', 'syllabus');
    expect(note?.source).toBe('student');
    expect(note?.kind).toBe('entity');
    expect(note?.description).toContain('syllabus.txt');
  });

  it('gives a student with no vault one', async () => {
    // Uploading may be the first thing they ever do. An entity note is what
    // makes vault.has() true, which is what puts the vault on the turn.
    const vault = await emptyVault();
    expect(await vault.has()).toBe(false);

    await importUpload(vault, {
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: bytes('Something.'),
    });

    expect(await vault.has()).toBe(true);
  });

  it('leaves one note when the same file is uploaded twice', async () => {
    const vault = await emptyVault();
    const file = {
      filename: 'syllabus.txt',
      mimeType: 'text/plain',
      bytes: bytes('Unit 1.'),
    };
    await importUpload(vault, file);
    await importUpload(vault, file);

    expect(await vault.count('entity')).toBe(1);
  });

  it('replaces the note when the same name arrives with new contents', async () => {
    const vault = await emptyVault();
    await importUpload(vault, {
      filename: 'syllabus.txt',
      mimeType: 'text/plain',
      bytes: bytes('The old plan.'),
    });
    await importUpload(vault, {
      filename: 'syllabus.txt',
      mimeType: 'text/plain',
      bytes: bytes('The new plan.'),
    });

    const note = await vault.read('entity', 'syllabus');
    expect(note?.body).toContain('The new plan');
    expect(note?.body).not.toContain('The old plan');
    expect(await vault.count('entity')).toBe(1);
  });

  it('refuses a scan instead of attaching an empty note', async () => {
    const vault = await emptyVault();
    // Not a real PDF, so extraction fails the way an unreadable one does.
    const result = await importUpload(vault, {
      filename: 'worksheet.pdf',
      mimeType: 'application/pdf',
      bytes: bytes('not really a pdf'),
    });

    expect(result.ok).toBe(false);
    expect(await vault.count('entity')).toBe(0);
  });

  it('refuses a type it cannot read, writing nothing', async () => {
    const vault = await emptyVault();
    const result = await importUpload(vault, {
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      bytes: bytes('\xff\xd8\xff'),
    });

    expect(result).toEqual({ ok: false, reason: 'unsupported-type' });
    expect(await vault.count('entity')).toBe(0);
  });

  it('refuses a file of whitespace, which extracts to nothing useful', async () => {
    const vault = await emptyVault();
    const result = await importUpload(vault, {
      filename: 'blank.txt',
      mimeType: 'text/plain',
      bytes: bytes('   \n\n  \t '),
    });

    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(await vault.count('entity')).toBe(0);
  });

  it('writes nothing outside the vault, whatever the file is called', async () => {
    const vault = await emptyVault();
    await importUpload(vault, {
      filename: '../../escaped.txt',
      mimeType: 'text/plain',
      bytes: bytes('Should stay inside.'),
    });

    // Everything that got written is under the vault's own directory.
    const entities = await readdir(join(vault.directory, 'entities'));
    expect(entities.length).toBe(1);
    const written = await readFile(join(vault.directory, 'entities', entities[0]!), 'utf8');
    expect(written).toContain('Should stay inside.');
  });
});
