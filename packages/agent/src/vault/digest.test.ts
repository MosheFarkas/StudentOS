import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from './vault.js';
import { vaultDigest } from './digest.js';

/**
 * What the profile writer is given to write from.
 *
 * Not the vault: three and a half thousand notes will not fit in a prompt and
 * would cost a fortune per rebuild if they did. Counting is free and exact, so
 * everything countable is counted here and the model is left to do the one
 * thing only it can -- turn a table into a sentence a person would say.
 */

describe('digesting a vault for the profile writer', () => {
  let root: string;
  let vault: Vault;

  const entity = (name: string, description: string, body: string) =>
    vault.write({ name, kind: 'entity', source: 'classroom', description, body });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-digest-'));
    vault = new Vault(root, 'student-1');

    await entity('french-10', 'Course', 'French 10, on Google Classroom.');
    await entity('drama-10a', 'Course', 'Drama 10A, on Google Classroom.');
    await entity(
      'culture-essay',
      'Assignment',
      'Culture essay.\n\nPart of [[french-10]].\nNo submission recorded, due date passed.',
    );
    await entity(
      'rehearsal',
      'Assignment',
      'Rehearsal.\n\nPart of [[drama-10a]].\nGraded and returned. Marked 7.',
    );
    await entity(
      'monologue',
      'Assignment',
      'Monologue.\n\nPart of [[drama-10a]].\nGraded and returned. Marked 5.',
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('says whether a course sets work, not how much', async () => {
    /*
     * How many pieces of work a course set turned out to be the least useful
     * thing in the generated document and the bulk of its length: "science
     * and technology (61 pieces of work and 167 files/readings), extended
     * history (43 and 86)". None of that changes what an agent says.
     *
     * What is worth one bit: whether it is a subject or a club. A course that
     * sets work is a lesson; one that never has is Model UN.
     */
    const digest = await vaultDigest(vault);
    expect(digest.courses.find((c) => c.name === 'drama-10a')?.setsWork).toBe(true);
    expect(digest.courses).not.toHaveProperty('0.assignments');
  });

  it('attaches a teacher to their own course, or to nothing', async () => {
    /*
     * The first version handed the writer a list of courses beside a list of
     * everyone who had ever emailed. It paired them, confidently, and named a
     * teacher who does not teach that subject.
     *
     * A teacher now belongs to the course whose announcements name them, or
     * is absent. There is no loose list of people to pair anything with.
     */
    await vault.write({
      name: '2026-01-01-a-notice',
      kind: 'episode',
      source: 'classroom',
      description: 'Announcement in French 10',
      occurred: '2026-01-01T10:00:00Z',
      body: 'In [[french-10]].\n\nMs. Coretti will collect these on Friday.',
    });
    await vault.write({
      name: '2026-01-02-another',
      kind: 'episode',
      source: 'classroom',
      description: 'Announcement in French 10',
      occurred: '2026-01-02T10:00:00Z',
      body: 'In [[french-10]].\n\nSee Ms Coretti about the oral.',
    });

    const digest = await vaultDigest(vault);
    expect(digest.courses.find((c) => c.name === 'french-10')?.teacher).toBe('Ms Coretti');
    // Drama's announcements say nothing, so drama has no teacher.
    expect(digest.courses.find((c) => c.name === 'drama-10a')?.teacher).toBeNull();
    expect(digest).not.toHaveProperty('people');
  });

  it('leaves out a course nothing has ever happened in', async () => {
    // An empty shell of a course crowds out a real one inside the budget.
    await entity('cas-2026-2027', 'Course', 'CAS, on Google Classroom.');
    const digest = await vaultDigest(vault);
    expect(digest.courses.map((c) => c.name)).not.toContain('cas-2026-2027');
  });

  it('is small enough to put in a prompt', async () => {
    const digest = await vaultDigest(vault);
    expect(JSON.stringify(digest).length).toBeLessThan(4000);
  });
});
