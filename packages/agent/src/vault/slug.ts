import { createHash } from 'node:crypto';

/**
 * Turning a title into a filename, safely.
 *
 * ContextoVault names notes after the things they describe -- a course, an
 * assignment, a person -- and those titles come from Classroom, from the school
 * portal, and eventually from email subject lines. None of that is written by
 * the student, and a note name is a path, so this function is where somebody
 * else's text becomes a filesystem operation.
 *
 * The rule is allow-list, never deny-list. Enumerating the dangerous
 * characters means missing one; permitting exactly `a-z`, `0-9` and `-` means
 * there is nothing to miss. `..`, slashes, backslashes, colons, null bytes and
 * newlines are not handled as special cases because they cannot survive.
 */

/**
 * Cap on a name's length.
 *
 * Well under the 255 bytes most filesystems allow, because a name is only half
 * of a path and a vault sits several directories down. Long enough that a
 * realistic assignment title survives whole.
 */
export const MAX_SLUG_LENGTH = 80;

/** Length of the hash kept when a title has to be truncated. */
const DIGEST_LENGTH = 8;

/** Used when a title reduces to nothing at all. */
const FALLBACK = 'untitled';

export function slugForNote(title: string): string {
  const slug = title
    // Accents fold rather than vanish: "Français" is a subject, "franais" is
    // a different note every time the encoding differs.
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    // Everything outside the allow-list becomes a separator, including the
    // characters that would otherwise make this a path.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');

  if (slug === '') return FALLBACK;
  if (slug.length <= MAX_SLUG_LENGTH) return slug;

  /*
   * Truncation has to stay unique.
   *
   * Two long assignment titles sharing a prefix would otherwise collapse into
   * one note, which merges two pieces of coursework into a single wrong answer
   * that looks like a right one. The digest is of the full title, so the name
   * stays stable across runs -- which is what re-syncing depends on.
   */
  const digest = createHash('sha256').update(title).digest('hex').slice(0, DIGEST_LENGTH);
  const room = MAX_SLUG_LENGTH - DIGEST_LENGTH - 1;
  return `${slug.slice(0, room).replace(/-$/, '')}-${digest}`;
}
