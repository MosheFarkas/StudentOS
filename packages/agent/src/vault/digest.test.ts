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

  it('counts the work each course set', async () => {
    const digest = await vaultDigest(vault);
    const drama = digest.courses.find((c) => c.name === 'drama-10a');
    expect(drama?.assignments).toBe(2);
    expect(digest.courses.find((c) => c.name === 'french-10')?.assignments).toBe(1);
  });

  it('reports marks only where marks exist', async () => {
    const digest = await vaultDigest(vault);
    expect(digest.courses.find((c) => c.name === 'drama-10a')?.marked).toBe(2);
    // No mark anywhere in French, so nothing to say about French marks.
    expect(digest.courses.find((c) => c.name === 'french-10')?.marked).toBe(0);
  });

  it('counts what has no submission separately from what was marked', async () => {
    /*
     * The distinction the whole document rests on. Classroom leaves work in
     * this state unless a student presses a button, so the count is about the
     * record and the writer is told to treat it that way.
     */
    const digest = await vaultDigest(vault);
    expect(digest.courses.find((c) => c.name === 'french-10')?.noSubmission).toBe(1);
    expect(digest.courses.find((c) => c.name === 'drama-10a')?.noSubmission).toBe(0);
  });

  it('names the people who actually write to this student', async () => {
    const wrote = (n: number, actor: string) =>
      vault.write({
        name: `2026-01-0${n}-a-notice`,
        kind: 'episode',
        source: 'gmail',
        description: `${actor} said something.`,
        actor,
        occurred: `2026-01-0${n}T10:00:00Z`,
        body: 'In [[french-10]].',
      });

    await wrote(1, 'Gabriela Carrara');
    await wrote(2, 'Gabriela Carrara');
    // One message is somebody who mailed once, not somebody in their life.
    await wrote(3, 'A Passing Stranger');

    const digest = await vaultDigest(vault);
    expect(digest.people).toEqual([{ name: 'Gabriela Carrara', messages: 2 }]);
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
