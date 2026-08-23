/**
 * Matching a question against remembered exchanges.
 *
 * The first version of memory_search used a single ILIKE over the whole query,
 * which requires the phrase to appear verbatim. Models do not write verbatim
 * phrases. The memory eval showed every real query returning nothing:
 * "chemistry teacher name" missed a line reading "my chemistry teacher is Mr
 * Ali", and the agent then told the student, honestly and wrongly, that it had
 * no record.
 *
 * So: split the question into terms, keep the ones that discriminate, and rank
 * an entry by how many of them it contains. Two terms out of three is a hit.
 *
 * Pure functions, exported, because the Postgres store and the eval's fake
 * store must rank identically -- otherwise the eval measures a retrieval
 * system that does not ship.
 */

/**
 * Words carried by nearly every question, which match nearly every entry.
 *
 * Kept deliberately short. This is not linguistics; it is the handful of words
 * that turn a specific query into a match on the entire table.
 */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'my',
  'me',
  'i',
  'you',
  'your',
  'we',
  'it',
  'this',
  'that',
  'these',
  'those',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'from',
  'what',
  'when',
  'where',
  'who',
  'which',
  'how',
  'why',
  'again',
  'about',
  'any',
  'some',
  'can',
  'could',
  'would',
  'should',
  'will',
  'am',
  'get',
  'got',
  'tell',
  'say',
  'said',
]);

/** Shorter than this and a term matches too much to be worth searching for. */
const MIN_TERM_LENGTH = 3;

/** The words in a question worth searching for, lowercased and deduplicated. */
export function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_TERM_LENGTH && !STOPWORDS.has(word));
  return [...new Set(words)];
}

/** The shape both stores agree on: enough to match and to order. */
export interface Matchable {
  content: string;
  occurredAt: Date;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word match, tolerant of a plural.
 *
 * Not stemming -- just the one ending that actually cost us recall. The eval
 * asked about "evenings" against a line reading "evening" and found nothing.
 * A real stemmer is a dependency and a source of surprising matches; this
 * handles the case that occurred without inviting the ones that have not.
 *
 * "art" still must not match "start", so the boundaries stay.
 */
function contains(content: string, term: string): boolean {
  // Both directions. Stripping alone turns "class" into "clas" and stops it
  // finding "classes"; adding alone leaves "evenings" unable to find
  // "evening". The query may be either side of the pair.
  const forms = new Set([term, `${term}s`, `${term}es`]);
  if (term.endsWith('es')) forms.add(term.slice(0, -2));
  if (term.endsWith('s')) forms.add(term.slice(0, -1));

  const pattern = [...forms].map(escape).join('|');
  return new RegExp(`\\b(?:${pattern})\\b`, 'i').test(content);
}

/**
 * Entries matching at least one term, best first.
 *
 * Ordered by how many distinct terms an entry contains, then by recency. The
 * count comes first because an entry naming both the subject and the teacher
 * is what was asked for; recency only settles ties.
 */
export function rankByTermMatches<T extends Matchable>(
  entries: readonly T[],
  terms: string[],
): T[] {
  if (terms.length === 0) return [];

  return entries
    .map((entry) => ({
      entry,
      score: terms.filter((term) => contains(entry.content, term)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) => b.score - a.score || b.entry.occurredAt.getTime() - a.entry.occurredAt.getTime(),
    )
    .map(({ entry }) => entry);
}
