import { describe, expect, it } from 'vitest';
import { settle, type Claim } from './claims.js';

/**
 * The distinction the whole vault was missing.
 *
 * Every note in it is an observation -- this message was sent, this file is
 * attached to this course -- and every reader of it was treating those
 * observations as conclusions. Three separate readers each re-derived meaning
 * from raw co-occurrence over a partial view, which is why more data made the
 * answers worse rather than better: "French" is a house as well as a subject,
 * and whoever writes to a class is usually but not always its teacher.
 *
 * A claim says which it is. An observed claim is a fact read off a note. An
 * inferred claim is somebody's reading of several notes, and has to carry the
 * evidence it was read from, how sure it is, and what else that evidence would
 * equally support. Settling is deterministic on purpose -- the model proposes,
 * this decides -- because a model asked to check its own reasoning fails in
 * the same direction it failed the first time.
 */

const claim = (over: Partial<Claim> = {}): Claim => ({
  subject: 'french-10',
  relation: 'taught by',
  object: 'Lucia Coretti',
  basis: 'inferred',
  evidence: [{ note: '2026-01-04-note', quote: 'Mme Coretti wrote to the class.' }],
  confidence: 0.9,
  ...over,
});

describe('settling what the vault is willing to say', () => {
  it('keeps a confident inference that has evidence behind it', () => {
    const { settled, withheld } = settle([claim()]);
    expect(settled.map((c) => c.object)).toEqual(['Lucia Coretti']);
    expect(withheld).toEqual([]);
  });

  it('refuses an inference that cannot name what it was read from', () => {
    /*
     * The rule that makes the rest of this meaningful. A claim with no
     * evidence cannot be checked, cannot be shown to a student who asks why,
     * and cannot be refuted -- so it is not a claim, it is a guess wearing
     * one's clothes.
     */
    const { settled, withheld } = settle([claim({ evidence: [] })]);
    expect(settled).toEqual([]);
    expect(withheld[0]?.reason).toBe('no-evidence');
  });

  it('refuses an inference nobody is sure of', () => {
    const { settled, withheld } = settle([claim({ confidence: 0.4 })]);
    expect(settled).toEqual([]);
    expect(withheld[0]?.reason).toBe('low-confidence');
  });

  it('withholds both when two readings of the same slot are close', () => {
    /*
     * The French failure, exactly. Two members of staff were named in that
     * course's announcements and the tie was broken on a count of one piece
     * of mail against zero. One is not a lead over none; it is noise that
     * happened to be non-zero, and the answer it produced was wrong.
     *
     * A slot with two live readings and no daylight between them has no
     * answer, and saying so is the correct output.
     */
    const rivals = [
      claim({ object: 'Lucia Coretti', confidence: 0.6 }),
      claim({ object: 'Anna Marzilli', confidence: 0.55 }),
    ];

    const { settled, withheld } = settle(rivals, { single: ['taught by'] });
    expect(settled).toEqual([]);
    expect(withheld.map((w) => w.reason)).toEqual(['no-clear-lead', 'no-clear-lead']);
  });

  it('lets a decisive leader through against a weak rival', () => {
    const rivals = [
      claim({ object: 'Chris George', confidence: 0.95 }),
      claim({ object: 'Daniella Malka', confidence: 0.3 }),
    ];

    const { settled } = settle(rivals, { single: ['taught by'] });
    expect(settled.map((c) => c.object)).toEqual(['Chris George']);
  });

  it('prefers what was observed over what was worked out', () => {
    /*
     * An observation is not in competition with an inference. Where Classroom
     * states the teacher outright, no amount of reasoning about who writes
     * the most mail gets to overrule it.
     */
    const rivals = [
      claim({ object: 'Anna Marzilli', confidence: 0.99 }),
      claim({
        object: 'Lucia Coretti',
        basis: 'observed',
        confidence: undefined,
        evidence: [{ note: 'french-10', quote: 'Teacher: Lucia Coretti' }],
      }),
    ];

    const { settled } = settle(rivals, { single: ['taught by'] });
    expect(settled.map((c) => c.object)).toEqual(['Lucia Coretti']);
  });

  it('drops observations that contradict each other outright', () => {
    // Two sources both stating a different answer for a slot that has one.
    // Nothing here can adjudicate, and picking the first is arbitrary.
    const rivals = [
      claim({ object: 'A. One', basis: 'observed', confidence: undefined }),
      claim({ object: 'B. Two', basis: 'observed', confidence: undefined }),
    ];

    const { settled, withheld } = settle(rivals, { single: ['taught by'] });
    expect(settled).toEqual([]);
    expect(withheld.map((w) => w.reason)).toEqual(['contradicted', 'contradicted']);
  });

  it('lets a relation hold many objects unless told otherwise', () => {
    /*
     * Relations are open text, not a fixed vocabulary, because a fixed one
     * force-fits whatever it failed to anticipate -- this school has houses
     * and form tutors and coaches, none of which a tidy list of edge types
     * would have had a slot for, and all of which would have been coerced
     * into "teaches".
     *
     * So contention is opt-in: a relation is many-valued until a caller says
     * this one admits a single answer.
     */
    const many = [
      claim({ relation: 'mentions', object: 'Lucia Coretti', confidence: 0.8 }),
      claim({ relation: 'mentions', object: 'Anna Marzilli', confidence: 0.8 }),
    ];

    const { settled } = settle(many);
    expect(settled).toHaveLength(2);
  });

  it('says what it withheld and why, rather than quietly dropping it', () => {
    // A pipeline that silently discards reads as one that found nothing.
    const { withheld } = settle([claim({ confidence: 0.1 })]);
    expect(withheld[0]?.claim.object).toBe('Lucia Coretti');
    expect(withheld[0]?.reason).toBe('low-confidence');
  });
});
