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

  it('takes a teacher from a settled claim rather than working one out', () => {
    /*
     * The digest used to derive this itself, three different ways, and each
     * one produced a confident wrong name: a classmate who emailed only about
     * maths, a head of year who wrote to every class he looked after, a
     * colleague who led on one email against none. All three were counts over
     * fragments, and no count over fragments can tell teaching apart from any
     * other reason to write to a class.
     *
     * The deriving now happens once, is challenged before it is stored, and
     * arrives here as a claim. Nothing in the digest re-reads the evidence
     * behind it -- a second opinion from the same fragments is the disease.
     */
    return (async () => {
      const digest = await vaultDigest(vault, [
        {
          subject: 'french-10',
          relation: 'taught by',
          object: 'Lucia Coretti',
          basis: 'inferred',
          evidence: [{ note: 'n1', quote: 'Mme Coretti will collect the essays.' }],
          confidence: 0.9,
        },
      ]);

      expect(digest.courses.find((c) => c.name === 'french-10')?.teacher).toBe('Lucia Coretti');
      // And a course no claim was settled for stays empty, rather than
      // borrowing the name from the course next to it.
      expect(digest.courses.find((c) => c.name === 'drama-10a')?.teacher).toBeNull();
      expect(digest).not.toHaveProperty('people');
    })();
  });

  it('leaves out a course nothing has ever happened in', async () => {
    // An empty shell of a course crowds out a real one inside the budget.
    await entity('cas-2026-2027', 'Course', 'CAS, on Google Classroom.');
    const digest = await vaultDigest(vault);
    expect(digest.courses.map((c) => c.name)).not.toContain('cas-2026-2027');
  });

  it('says when each course was last doing anything', async () => {
    /*
     * The document said this student was "preparing for the history exam and
     * completing an IB MYP Personal Project" on the 26th of August. The exam
     * prep course last set work in November and the Personal Project in
     * February. Both had been over for months, and the vault knew: every note
     * in them is dated and nothing had happened since.
     *
     * A digest with no time in it, for a vault whose whole design is
     * temporal, is how that happened.
     */
    await vault.write({
      name: '2026-06-10-a-notice',
      kind: 'episode',
      source: 'classroom',
      description: 'Announcement in French 10',
      occurred: '2026-06-10T10:00:00Z',
      body: 'In [[french-10]].',
    });

    const digest = await vaultDigest(vault);
    expect(digest.courses.find((c) => c.name === 'french-10')?.lastSeen).toBe('2026-06-10');
    // Drama has assignments but no dated activity, so it has none to report.
    expect(digest.courses.find((c) => c.name === 'drama-10a')?.lastSeen).toBeNull();
  });

  it('reports the last date work was due in a course', async () => {
    // The other half of "is this course over": a course whose last deadline
    // was nine months ago is not one they are in the middle of.
    await vault.write({
      name: 'old-essay',
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      body: 'Old essay.\n\nPart of [[french-10]].\nDue: 2025-11-24T03:59',
    });

    const digest = await vaultDigest(vault);
    expect(digest.courses.find((c) => c.name === 'french-10')?.lastDue).toBe('2025-11-24');
  });

  it('says what day it is, because nothing else in the prompt does', async () => {
    /*
     * A model has no clock. Told a course last ran in June and nothing else,
     * it cannot know whether that is last week or last year -- and it wrote
     * the summer holidays as though term were still going.
     */
    const digest = await vaultDigest(vault);
    expect(digest.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is small enough to put in a prompt', async () => {
    const digest = await vaultDigest(vault);
    expect(JSON.stringify(digest).length).toBeLessThan(4000);
  });
});
