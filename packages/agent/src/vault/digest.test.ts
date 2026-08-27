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

  it('calls a course what the school calls it, not what the filename says', () => {
    /*
     * The document listed courses by their slug -- "grade-10-math-2025-2026"
     * -- and the writer was left to turn that back into something a person
     * would say. That is inference, and it was being done with no evidence, in
     * the pass with the least room to do it.
     *
     * No inference is needed. The school typed a name into Classroom and the
     * importer wrote it down. Reading it is free and cannot be wrong.
     */
    return (async () => {
      const digest = await vaultDigest(vault);
      expect(digest.courses.find((c) => c.name === 'french-10')?.title).toBe('French 10');
    })();
  });

  it('reports what kind of thing a course is, from a settled claim', () => {
    /*
     * Everything arrives from Google Classroom as a "course", and this was
     * guessed from whether any work had ever been set -- a bit that is wrong
     * in both directions, since a club that once posted a form sets work and a
     * subject marked on paper does not. Worse, the guess was handed to the
     * writer as a "hint" for it to make something of, which is the same
     * fragment-shuffling one level along.
     */
    return (async () => {
      const digest = await vaultDigest(vault, [
        {
          subject: 'french-10',
          relation: 'is',
          object: 'a house or form group',
          basis: 'inferred',
          evidence: [{ note: 'n1', quote: 'House points assembly Thursday.' }],
          confidence: 0.9,
        },
      ]);

      expect(digest.courses.find((c) => c.name === 'french-10')?.kind).toBe(
        'a house or form group',
      );
      expect(digest.courses.find((c) => c.name === 'drama-10a')?.kind).toBeNull();
    })();
  });

  it('reports whether a course is running, rather than dates to reason from', () => {
    /*
     * The digest used to hand over the last thing that happened and the last
     * deadline set, and leave the writer to work out where in a school year
     * that fell -- a judgement about terms and holidays, made in a pass with
     * no room for it. A document written in late August had a student
     * preparing for an exam sat the previous November.
     */
    return (async () => {
      const digest = await vaultDigest(vault, [
        {
          subject: 'french-10',
          relation: 'is currently',
          object: 'finished',
          basis: 'inferred',
          evidence: [{ note: 'n1', quote: '2025-11-20: last thing that happened.' }],
          confidence: 0.9,
        },
      ]);

      expect(digest.courses.find((c) => c.name === 'french-10')?.state).toBe('finished');
      // And a course nothing was settled about says nothing, rather than
      // borrowing a state from the course next to it.
      expect(digest.courses.find((c) => c.name === 'drama-10a')?.state).toBeNull();
    })();
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

      expect(digest.courses.find((c) => c.name === 'french-10')?.teachers).toEqual([
        'Lucia Coretti',
      ]);
      // And a course no claim was settled for stays empty, rather than
      // borrowing the name from the course next to it.
      expect(digest.courses.find((c) => c.name === 'drama-10a')?.teachers).toEqual([]);
      expect(digest).not.toHaveProperty('people');
    })();
  });

  it('leaves out a course nothing has ever happened in', async () => {
    // An empty shell of a course crowds out a real one inside the budget.
    await entity('cas-2026-2027', 'Course', 'CAS, on Google Classroom.');
    const digest = await vaultDigest(vault);
    expect(digest.courses.map((c) => c.name)).not.toContain('cas-2026-2027');
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
