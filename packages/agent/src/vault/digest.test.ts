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

  it('offers no teachers, because the vault does not know any', async () => {
    /*
     * Mail is the only source of a person's name here, and somebody writing
     * about a course is not its teacher. On a real account the top
     * correspondent for maths, French and robotics was the same man, and the
     * top name for English was not the English teacher.
     *
     * Handing the writer a list of courses and a separate list of people got
     * exactly what you would expect: it paired them, confidently, and put a
     * wrong teacher into every conversation. Naming teachers needs the
     * Classroom roster scope, which is not granted, so the honest answer is
     * to offer nothing rather than a guess.
     */
    const digest = await vaultDigest(vault);
    expect(digest).not.toHaveProperty('people');
    expect(JSON.stringify(digest)).not.toMatch(/teacher/i);
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
