import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from './vault.js';
import { readGrade } from './grade.js';

/**
 * Which year at school this student is in.
 *
 * The fact the old pass got wrong every summer. Their mail says Grade 10
 * because that is what it said in March; by late August they are in Grade 11
 * and nothing has written it down anywhere. Reading the evidence is half the
 * answer -- the other half is counting the years that have ended since.
 */

describe('reading which year a student is in', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-grade-'));
    vault = new Vault(root, 'student-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const said = (text: string, occurred: string) =>
    vault.write({
      name: `mail-${occurred.slice(0, 10)}`,
      kind: 'episode',
      source: 'gmail',
      description: 'A message',
      occurred,
      event: 'message',
      body: text,
    });

  it('is null when nothing says', async () => {
    expect(await readGrade(vault, { today: '2026-08-26' })).toBeNull();
  });

  it('reads what the evidence says', async () => {
    await said('Grade 10 parents evening is on Thursday.', '2026-03-14T09:00:00.000Z');

    const grade = await readGrade(vault, { today: '2026-03-20' });
    expect(grade?.grade).toBe(10);
    expect(grade?.rolledForward).toBe(0);
  });

  it('moves them up over the summer, which is the whole point', async () => {
    /*
     * The bug this exists to fix.
     *
     * Every piece of mail on this account says Grade 10, because that is what
     * it said in March. On the 26th of August they are in Grade 11 and nothing
     * anywhere has written that down.
     */
    await said('Grade 10 parents evening is on Thursday.', '2026-03-14T09:00:00.000Z');

    const grade = await readGrade(vault, { today: '2026-08-26' });
    expect(grade?.grade).toBe(11);
    expect(grade?.rolledForward).toBe(1);
  });

  it('moves them up twice when two years have ended', async () => {
    await said('Grade 9 reports go out Friday.', '2025-05-02T09:00:00.000Z');
    expect((await readGrade(vault, { today: '2026-09-01' }))?.grade).toBe(11);
  });

  it('uses the school’s own year end when it has one', async () => {
    // A school whose year runs to late June has already turned over by this
    // date; one running to August has not.
    await said('Grade 10 reports go out Friday.', '2026-05-02T09:00:00.000Z');

    expect((await readGrade(vault, { today: '2026-06-25', yearEnd: '06-20' }))?.grade).toBe(11);
    expect((await readGrade(vault, { today: '2026-06-25', yearEnd: '08-15' }))?.grade).toBe(10);
  });

  it('believes the most recent statement', async () => {
    await said('Grade 9 reports go out Friday.', '2025-05-02T09:00:00.000Z');
    await said('Welcome to Grade 10.', '2025-09-04T09:00:00.000Z');

    const grade = await readGrade(vault, { today: '2025-09-20' });
    expect(grade?.grade).toBe(10);
  });

  it('reads Year and Form as readily as Grade', async () => {
    await said('Year 11 assembly is on Monday.', '2026-09-04T09:00:00.000Z');
    expect((await readGrade(vault, { today: '2026-09-20' }))?.grade).toBe(11);
  });

  it('does not read a year out of a course name', async () => {
    /*
     * How this was got wrong before.
     *
     * A slug like grade-10-math-2025-2026 is right until a student takes one
     * class with an older cohort, and it carries no date to roll forward from.
     */
    await vault.write({
      name: 'grade-10-math',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Grade 10 Math, on Google Classroom.',
    });

    expect(await readGrade(vault, { today: '2026-08-26' })).toBeNull();
  });

  it('ignores a statement with no date, having nothing to roll forward from', async () => {
    await vault.write({
      name: 'undated',
      kind: 'episode',
      source: 'gmail',
      description: 'A message',
      event: 'message',
      body: 'Grade 10 parents evening is on Thursday.',
    });

    expect(await readGrade(vault, { today: '2026-08-26' })).toBeNull();
  });

  it('stops at the top of school rather than inventing a Grade 14', async () => {
    await said('Grade 12 graduation is in June.', '2026-03-14T09:00:00.000Z');
    expect((await readGrade(vault, { today: '2028-09-01' }))?.grade).toBe(12);
  });
});
