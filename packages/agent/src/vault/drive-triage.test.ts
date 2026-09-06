import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vault } from './vault.js';
import type { DriveFile } from './drive.js';
import { judgeDriveFiles } from './drive-triage.js';

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

  it('passes over a file last changed before last school year began', async () => {
    const llm = saying();

    const judged = await judge(llm, [file({ modifiedAt: '2024-11-03T10:00:00.000Z' })]);

    expect(llm.chat).not.toHaveBeenCalled();
    expect(judged.size).toBe(0);
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
