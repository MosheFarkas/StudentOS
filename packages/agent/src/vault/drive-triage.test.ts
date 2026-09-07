import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import type { DriveFile } from './drive.js';
import { judgeDriveFiles, standingOf, type DriveLedger } from './drive-triage.js';

/**
 * Deciding about every file in a Drive, not only the ones in a course folder.
 *
 * A student who connects Drive has handed over the whole of it, and a folder
 * that names a course places only a fraction. The rest used to be thrown away
 * unread -- a CAS brainstorming document with them. Now they are judged, in
 * batches, on what a listing says about them, and the verdicts are kept so a
 * file is asked about once.
 */

const TODAY = '2026-09-06';
const YEAR_START = '2026-06-19';

/**
 * A model that answers about a file by the number it was listed under, found
 * from the listing it was shown -- tests say which file they mean by name.
 */
const saying = (...answers: { file: string; keep: boolean; inCourse?: string | null }[]) => ({
  chat: vi.fn(async (request: { messages: { content?: unknown }[] }, _c?: unknown) => {
    const asked = String(request.messages.at(-1)?.content ?? '');
    const numberOf = (name: string): number | string => {
      const line = asked
        .split('\n')
        .find((row) => /^\s*\d+\. /.test(row) && row.includes(`. ${name}`));
      return line ? Number(line.trim().split('.')[0]) : name;
    };
    return {
      content: JSON.stringify({
        files: answers.map((answer) => ({
          file: numberOf(answer.file),
          keep: answer.keep,
          inCourse: answer.inCourse ?? null,
        })),
      }),
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 },
      finishReason: 'stop' as const,
    };
  }),
});

const file = (over: Partial<DriveFile> = {}): DriveFile => ({
  fileId: 'd1',
  name: 'cas project brainstorming',
  mimeType: 'application/vnd.google-apps.document',
  ownedByStudent: true,
  modifiedAt: '2026-09-01T10:00:00.000Z',
  ...over,
});

describe('judging the files in a Drive', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-drivetriage-'));
    vault = new Vault(root, 'student-1');
    await vault.write({
      name: 'history',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      externalId: 'c-1',
      body: 'History, on Google Classroom.',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const judge = (llm: unknown, files: DriveFile[], school?: string) =>
    judgeDriveFiles({ llm } as never, {
      vault,
      files,
      today: TODAY,
      yearStart: YEAR_START,
      userId: 'u-1',
      ...(school ? { school } : {}),
    });

  it('keeps what the model keeps, linked to the course it named', async () => {
    const llm = saying({ file: 'History revision notes', keep: true, inCourse: 'History' });

    const judged = await judge(llm, [file({ name: 'History revision notes' })]);

    expect(judged.get('d1')).toEqual({ keep: true, course: 'history' });
  });

  it('keeps a file about school that belongs to no one course', async () => {
    const llm = saying({ file: 'cas project brainstorming', keep: true });

    const judged = await judge(llm, [file()]);

    expect(judged.get('d1')).toEqual({ keep: true, course: null });
  });

  it('leaves out what the model leaves out', async () => {
    const llm = saying({ file: 'Summer photos', keep: false });

    const judged = await judge(llm, [file({ name: 'Summer photos', mimeType: 'image/jpeg' })]);

    expect(judged.get('d1')).toEqual({ keep: false, course: null });
  });

  it('links only to a course on the list', async () => {
    // A wrong subject is worse than no subject, and a name off the list is a guess.
    const llm = saying({ file: 'cas project brainstorming', keep: true, inCourse: 'Chemistry' });

    const judged = await judge(llm, [file()]);

    expect(judged.get('d1')).toEqual({ keep: true, course: null });
  });

  it('remembers a verdict, so the next refresh does not ask again', async () => {
    const llm = saying({ file: 'Summer photos', keep: false });
    const files = [file({ name: 'Summer photos' })];

    await judge(llm, files);
    const again = await judge(llm, files);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(again.get('d1')).toEqual({ keep: false, course: null });
  });

  it('asks again once the file has changed', async () => {
    const llm = saying({ file: 'Summer photos', keep: false });

    await judge(llm, [file({ name: 'Summer photos', modifiedAt: '2026-09-01T10:00:00.000Z' })]);
    await judge(llm, [file({ name: 'Summer photos', modifiedAt: '2026-09-04T10:00:00.000Z' })]);

    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('refuses a file last changed before last school year began, without asking', async () => {
    const llm = saying();

    const judged = await judge(llm, [file({ modifiedAt: '2024-11-03T10:00:00.000Z' })]);

    expect(llm.chat).not.toHaveBeenCalled();
    expect(judged.get('d1')).toEqual({ keep: false, course: null });
  });

  it('refuses a temporary or system file without asking', async () => {
    const llm = saying();

    const judged = await judge(llm, [
      file({ fileId: 'j1', name: '.DS_Store' }),
      file({ fileId: 'j2', name: '~$rk_Process_Journal.docx' }),
      file({ fileId: 'j3', name: '~ai-a644bade-242e.tmp' }),
      file({ fileId: 'j4', name: 'desktop.ini' }),
    ]);

    expect(llm.chat).not.toHaveBeenCalled();
    for (const id of ['j1', 'j2', 'j3', 'j4']) {
      expect(judged.get(id)).toEqual({ keep: false, course: null });
    }
  });

  it('tells the model which subjects are over, and what grade the student is in', async () => {
    const llm = saying({ file: 'STE: Electricity-Magnetism', keep: false });

    await judgeDriveFiles({ llm } as never, {
      vault,
      files: [file({ name: 'STE: Electricity-Magnetism' })],
      today: TODAY,
      yearStart: YEAR_START,
      userId: 'u-1',
      dropped: ['2025/2026 - 10 Science and Technology - 04 (ST and STE)'],
      grade: 11,
    });

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).toContain('10 Science and Technology');
    expect(sent).toContain('Grade 11');
  });

  it('shows the model what the reader found in a file the vault already holds', async () => {
    /*
     * A file kept on its name alone and then opened: the sentence the reader
     * wrote is the best evidence there is about it, and a name like "Unit 4"
     * says nothing. Asked again, the model sees both.
     */
    await vault.write({
      name: 'unit-4',
      kind: 'entity',
      source: 'drive',
      description: 'File',
      externalId: 'd1',
      body: 'Unit 4.\n\nYours -- you made this.\n\n## What is in it (slides)\n\nThis 10 Science slide deck covers electricity and magnetism.',
    });
    const llm = saying({ file: 'Unit 4', keep: false });

    const judged = await judge(llm, [file({ name: 'Unit 4' })]);

    expect(JSON.stringify(llm.chat.mock.calls[0]?.[0])).toContain('10 Science slide deck');
    expect(judged.get('d1')).toEqual({ keep: false, course: null });
  });

  it('asks again about everything once the rule has changed', async () => {
    /*
     * A verdict given under an older rule is not this rule's verdict. The
     * ledger carries the rule it was written under, and one written under
     * another is set aside -- every file asked once more, then remembered.
     */
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(
      join(vault.directory, 'drive-judged.json'),
      JSON.stringify({ d1: { keep: true, course: null, modifiedAt: '2026-09-01T10:00:00.000Z' } }),
    );
    const llm = saying({ file: 'cas project brainstorming', keep: true });

    await judge(llm, [file()]);

    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('passes over a file Classroom already knows, and one a folder already places', async () => {
    await vault.write({
      name: 'worksheet',
      kind: 'entity',
      source: 'classroom',
      description: 'File',
      externalId: 'd-known',
      body: 'A worksheet.\nPart of [[history]].',
    });
    const llm = saying();

    const judged = await judge(llm, [
      file({ fileId: 'd-known', name: 'Worksheet' }),
      file({ fileId: 'd-filed', name: 'Essay outline', path: ['History'] }),
    ]);

    expect(llm.chat).not.toHaveBeenCalled();
    expect(judged.size).toBe(0);
  });

  it('treats an answer it cannot read as no verdict at all', async () => {
    const llm = {
      chat: vi.fn(async () => ({
        content: 'I could not decide.',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 },
        finishReason: 'stop' as const,
      })),
    };

    const judged = await judge(llm, [file()]);
    await judge(llm, [file()]);

    // Nothing kept, nothing remembered: asked again next time.
    expect(judged.size).toBe(0);
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('asks in batches rather than about the whole Drive at once', async () => {
    const files = Array.from({ length: 120 }, (_, i) =>
      file({ fileId: `d-${i}`, name: `Doc ${i}` }),
    );
    const llm = saying(...files.map((f) => ({ file: f.name, keep: false })));

    await judge(llm, files);

    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

  it('shows the model the courses and what is known about the school', async () => {
    const llm = saying({ file: 'cas project brainstorming', keep: true });

    await judge(llm, [file()], 'The school runs the IB Diploma, including CAS.');

    const sent = JSON.stringify(llm.chat.mock.calls[0]?.[0]);
    expect(sent).toContain('History');
    expect(sent).toContain('including CAS');
    expect(sent).toContain('cas project brainstorming');
  });
});

describe('where a file stands, before anybody is asked', () => {
  /*
   * One rule for the judge and for the script that explains the judge, so the
   * two cannot disagree about why a file is where it is.
   */
  const courses = new Map([['History', 'history']]);
  const known = new Map([
    ['d-known', 'classroom'],
    ['d-kept', 'drive'],
  ]);
  const ledger: DriveLedger = {
    'd-out': { keep: false, course: null, modifiedAt: '2026-09-01T10:00:00.000Z' },
  };
  const at = (over: Partial<DriveFile> = {}) =>
    standingOf(file(over), { known, courses, lastYearBegan: '2025-06-19', ledger });

  it('says a folder or a shortcut is not a file', () => {
    expect(at({ mimeType: 'application/vnd.google-apps.folder' })).toEqual({ why: 'not-a-file' });
    expect(at({ mimeType: 'application/vnd.google-apps.shortcut' })).toEqual({ why: 'not-a-file' });
  });

  it('says Classroom already has it', () => {
    expect(at({ fileId: 'd-known' })).toEqual({ why: 'classroom' });
  });

  it('judges a file the vault already holds from Drive like any other', () => {
    // Kept once on its name; when the rule moves, it is asked about again.
    expect(at({ fileId: 'd-kept' })).toEqual({ why: 'unjudged' });
  });

  it('says a temporary or system file is junk', () => {
    expect(at({ name: '.DS_Store' })).toEqual({ why: 'junk' });
    expect(at({ name: '~$essay.docx' })).toEqual({ why: 'junk' });
    expect(at({ name: 'notes.tmp' })).toEqual({ why: 'junk' });
    expect(at({ name: 'Thumbs.db' })).toEqual({ why: 'junk' });
    expect(at({ name: 'CAS project Brainstorming' })).toEqual({ why: 'unjudged' });
  });

  it('says a folder placed it, and under what', () => {
    expect(at({ path: ['Gr 10', 'History'] })).toEqual({ why: 'folder', course: 'history' });
  });

  it('says it is too old to be judged', () => {
    expect(at({ modifiedAt: '2024-11-03T10:00:00.000Z' })).toEqual({ why: 'too-old' });
  });

  it('says what was remembered about it', () => {
    expect(at({ fileId: 'd-out' })).toEqual({
      why: 'remembered',
      verdict: { keep: false, course: null },
    });
  });

  it('says a changed file is no longer remembered', () => {
    expect(at({ fileId: 'd-out', modifiedAt: '2026-09-05T10:00:00.000Z' })).toEqual({
      why: 'unjudged',
    });
  });

  it('says nobody has judged it yet', () => {
    expect(at()).toEqual({ why: 'unjudged' });
  });
});
