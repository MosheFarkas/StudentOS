import { describe, expect, it } from 'vitest';
import { slugForNote, MAX_SLUG_LENGTH } from './slug.js';

/**
 * Turning somebody else's words into a filename.
 *
 * Note names come from course titles, assignment titles and eventually email
 * subjects -- written by teachers, by schools, and by anyone who can send a
 * student mail. A name is a path, so this is the one place in ContextoVault
 * where hostile text becomes a filesystem operation.
 *
 * Everything else in the vault can be wrong and be fixed. A name that escapes
 * the vault directory writes somewhere on the droplet.
 */

describe('naming a note', () => {
  it('lowercases and hyphenates ordinary titles', () => {
    expect(slugForNote('Chemistry')).toBe('chemistry');
    expect(slugForNote('Mr Ali')).toBe('mr-ali');
    expect(slugForNote('Cold War Essay (Draft 2)')).toBe('cold-war-essay-draft-2');
  });

  it('folds accents rather than dropping the letter', () => {
    // French is a subject. "Franais" would be a different note every time the
    // accent came through differently.
    expect(slugForNote('Français')).toBe('francais');
    expect(slugForNote('Étude de cas')).toBe('etude-de-cas');
  });

  it('collapses and trims separators', () => {
    expect(slugForNote('  Physics   --  Paper 1  ')).toBe('physics-paper-1');
    expect(slugForNote('A -- B')).toBe('a-b');
  });
});

describe('names that are attacks', () => {
  it('strips path traversal entirely', () => {
    expect(slugForNote('../../etc/passwd')).toBe('etc-passwd');
    expect(slugForNote('..')).not.toContain('.');
    expect(slugForNote('../../../root/.ssh/authorized_keys')).not.toContain('..');
  });

  it('never leaves a separator of any kind in the name', () => {
    for (const hostile of [
      'a/b',
      'a\\b',
      'a\u0000b',
      'a:b',
      '~/secrets',
      'C:\\Windows\\System32',
      'note\nname',
    ]) {
      const slug = slugForNote(hostile);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('refuses to produce a name that is only dots or empty', () => {
    // An empty name means writing to the directory itself.
    for (const nothing of ['', '   ', '...', '///', '\u0000', '???']) {
      const slug = slugForNote(nothing);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('bounds the length, because filesystems do', () => {
    const slug = slugForNote('word '.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('gives different names to titles that differ past the cap', () => {
    /*
     * Two long assignment titles sharing a prefix must not collide into one
     * note -- silently merging two pieces of coursework is a wrong answer that
     * looks like a right one.
     */
    const a = slugForNote(`${'the same beginning '.repeat(10)}alpha`);
    const b = slugForNote(`${'the same beginning '.repeat(10)}beta`);
    expect(a).not.toBe(b);
  });

  it('is stable: the same title always gives the same name', () => {
    // Re-syncing depends on this. An unstable slug means a new file per run.
    expect(slugForNote('Chemistry')).toBe(slugForNote('Chemistry'));
    expect(slugForNote('Cold War Essay')).toBe(slugForNote('Cold  War   Essay'));
  });
});
