import { untrustedNote } from '../untrusted.js';
import type { NoteSource, VaultNote } from './vault.js';

/**
 * Turning ContextoVault notes into prompt text.
 *
 * The only path from a note to a model, deliberately. The warning that gmail.ts
 * and portal.ts attach to what they return protects one turn; a note distilled
 * from the same material and read back later would carry none of it. Making
 * rendering the single entrance means the boundary cannot be forgotten by
 * whoever adds the next reader -- there is no way to read the vault that skips
 * this file.
 */

/** Sources whose material this product wrote, or the student did. */
const OURS: ReadonlySet<NoteSource> = new Set<NoteSource>(['student', 'agent']);

const OPEN = '<untrusted>';
const CLOSE = '</untrusted>';

const IMPORTED_WARNING = untrustedNote(
  'The notes below were built from material written by other people -- teachers, schools, ' +
    'and whoever sent the mail -- not by the student.',
);

/**
 * Stop a note ending the block it is inside.
 *
 * The attack: an email subject, an assignment title or a portal page containing
 * the closing delimiter would otherwise finish the untrusted section early, and
 * everything after it would be read as though this product had written it.
 *
 * Defanged rather than deleted, so a student reading their own vault still sees
 * what the message actually said.
 */
function defang(body: string): string {
  return body.replaceAll('<', '‹').replaceAll('>', '›');
}

function renderOne(note: VaultNote, body: string): string {
  return `## ${note.name}${note.description ? ` (${note.description})` : ''}\n${body}`;
}

export function renderNotes(notes: readonly VaultNote[]): string {
  if (notes.length === 0) return '';

  const ours = notes.filter((note) => OURS.has(note.source));
  const theirs = notes.filter((note) => !OURS.has(note.source));

  const sections: string[] = [];

  for (const note of ours) sections.push(renderOne(note, note.body));

  /*
   * One warning for the whole block rather than one per note.
   *
   * Repeating it would cost more than the notes do, and this block is already
   * the expensive part of any prompt that carries it.
   */
  if (theirs.length > 0) {
    const inside = theirs.map((note) => renderOne(note, defang(note.body))).join('\n\n');
    sections.push(`${OPEN}\n${IMPORTED_WARNING}\n\n${inside}\n${CLOSE}`);
  }

  return sections.join('\n\n');
}
