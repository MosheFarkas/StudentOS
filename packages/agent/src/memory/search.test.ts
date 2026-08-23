import { describe, expect, it } from 'vitest';
import { queryTerms, rankByTermMatches } from './search.js';

/**
 * Why this is not substring matching.
 *
 * The memory eval caught it: the agent asks for "chemistry teacher name" and
 * the stored line reads "my chemistry teacher is Mr Ali". Every one of those
 * queries returned nothing, because ILIKE wants the whole phrase verbatim and
 * a model never writes one. The tool passed its unit tests and recalled almost
 * nothing.
 *
 *   "chemistry teacher name"                      -> 0 hits
 *   "EPQ topic subject question idea"             -> 0 hits
 *   "calendar evenings busy schedule commitments" -> 0 hits
 */

const entry = (content: string, hoursAgo = 0) => ({
  content,
  occurredAt: new Date(Date.now() - hoursAgo * 3_600_000),
});

describe('turning a question into search terms', () => {
  it('splits a natural-language query into words', () => {
    expect(queryTerms('chemistry teacher name')).toEqual(['chemistry', 'teacher', 'name']);
  });

  it('drops the words every query contains', () => {
    // Without this, "what is my chemistry teacher" matches every entry
    // containing "is" -- which is all of them.
    expect(queryTerms('what is my chemistry teacher')).toEqual(['chemistry', 'teacher']);
  });

  it('drops terms too short to discriminate', () => {
    expect(queryTerms('do i have a EPQ')).toEqual(['epq']);
  });

  it('keeps two-letter subject names', () => {
    // PE, RE and DT are real subjects. A three-character floor deleted them,
    // and "what did i get in RE" produced an empty query -- unanswerable by
    // construction, for a product aimed at UK students.
    expect(queryTerms('what did i get in RE')).toEqual(['re']);
    expect(queryTerms('when is my PE lesson')).toEqual(['pe', 'lesson']);
    expect(queryTerms('hows my DT coursework')).toContain('dt');
  });

  it('still drops two-letter words that are noise', () => {
    // The floor was doing real work: without stopwords covering them, "so",
    // "as" and "up" match most of the table.
    expect(queryTerms('so is it up to me as by')).toEqual([]);
  });

  it('strips punctuation the model adds', () => {
    expect(queryTerms("my sister's name?")).toEqual(['sister', 'name']);
  });
});

describe('ranking by how many terms an entry matches', () => {
  it('finds an entry that matches only some of the query', () => {
    // The whole point: two of three terms is a hit, not a miss.
    const entries = [entry('Student: my chemistry teacher is Mr Ali')];
    expect(rankByTermMatches(entries, queryTerms('chemistry teacher name'))).toHaveLength(1);
  });

  it('puts the entry matching more terms first', () => {
    const entries = [
      entry('Student: i like chemistry'),
      entry('Student: my chemistry teacher is Mr Ali'),
    ];
    const ranked = rankByTermMatches(entries, queryTerms('chemistry teacher'));
    expect(ranked[0]?.content).toContain('Mr Ali');
  });

  it('breaks ties by recency, newest first', () => {
    const entries = [
      entry('Student: chemistry is on tuesday', 100),
      entry('Student: chemistry is on friday', 1),
    ];
    const ranked = rankByTermMatches(entries, queryTerms('chemistry'));
    expect(ranked[0]?.content).toContain('friday');
  });

  it('excludes entries matching nothing', () => {
    const entries = [entry('Student: whats the capital of norway')];
    expect(rankByTermMatches(entries, queryTerms('chemistry teacher'))).toEqual([]);
  });

  it('matches whole words, not fragments', () => {
    // "art" must not match "start". Fragment matching would return noise for
    // every short subject name a student has.
    const entries = [entry('Student: when do i start revision')];
    expect(rankByTermMatches(entries, queryTerms('art coursework'))).toEqual([]);
  });

  it('matches across singular and plural', () => {
    // The memory eval caught this: the query said "evenings" and the stored
    // line said "evening", so football training on Tuesdays was unfindable.
    const entries = [entry('Student: i have football training every tuesday evening')];
    expect(rankByTermMatches(entries, queryTerms('busy evenings'))).toHaveLength(1);
    expect(
      rankByTermMatches([entry('Student: my classes are full')], queryTerms('class')),
    ).toHaveLength(1);
  });

  it('returns nothing when the query was all stopwords', () => {
    expect(rankByTermMatches([entry('anything')], queryTerms('what is that'))).toEqual([]);
  });
});
