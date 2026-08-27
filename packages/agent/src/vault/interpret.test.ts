import { describe, expect, it } from 'vitest';
import { interpret, type Question } from './interpret.js';

/**
 * Proposing a reading, then trying to knock it down.
 *
 * Every wrong answer this vault has produced came from a single forward pass
 * with nothing checking it. Asked who teaches French, a model answers with a
 * name, because being asked a question is itself pressure to produce one --
 * and nothing downstream could tell a name that was read from evidence apart
 * from a name that was the least-bad guess.
 *
 * So there are two calls and a set of rules between them. The first proposes
 * and is told plainly that abstaining scores better than guessing. The second
 * is told the proposal and asked to refute it, which is a different question
 * with a different failure mode -- the two do not fail in the same direction.
 * Everything either of them returns is then checked against the evidence they
 * were given, here, where a model cannot argue with it.
 */

/**
 * A scripted model. Each reply is returned in order, and calls are recorded.
 *
 * Once the script runs out the last reply repeats, which reads as "every
 * refuter said the same thing". Without that, every test about proposing or
 * about qualifiers would have to know how many times a claim is challenged,
 * and changing that number would break a dozen tests that are not about it.
 */
function fake(replies: string[]) {
  const asked: string[] = [];
  return {
    asked,
    llm: {
      chat: async (request: { messages: { role: string; content: string }[] }) => {
        asked.push(request.messages.map((m) => m.content).join('\n'));
        const reply = replies[asked.length - 1] ?? (replies.length > 0 ? replies.at(-1) : '');
        return { content: reply ?? '', toolCalls: [] } as never;
      },
    },
  };
}

const question: Question = {
  subject: 'french-10',
  relation: 'taught by',
  asking: 'Who teaches this course?',
  candidates: ['Lucia Coretti', 'Anna Marzilli'],
  guarantees: ['Every quote below was taken from a note attached to french-10.'],
  evidence: [
    { note: 'a-notice', quote: 'Mme Coretti will collect the essays on Friday.' },
    { note: 'b-notice', quote: 'Mme Marzilli is running the exchange trip.' },
  ],
};

const propose = (body: object) => JSON.stringify(body);

describe('interpreting evidence into a claim', () => {
  it('returns a claim when a confident proposal survives refutation', async () => {
    const { llm } = fake([
      propose({
        answer: 'Lucia Coretti',
        confidence: 0.85,
        evidence: ['a-notice'],
        alternatives: [],
      }),
      propose({ refuted: false, why: 'The announcement has her collecting the work.' }),
    ]);

    const [claim] = await interpret({ llm }, question, { userId: 'u1' });
    expect(claim?.object).toBe('Lucia Coretti');
    expect(claim?.basis).toBe('inferred');
    expect(claim?.evidence[0]?.note).toBe('a-notice');
  });

  it('returns nothing when the proposal abstains', async () => {
    const { llm, asked } = fake([propose({ answer: null, why: 'Two names, no way to choose.' })]);

    expect(await interpret({ llm }, question, { userId: 'u1' })).toEqual([]);
    // And does not pay for a refutation of a claim nobody made.
    expect(asked).toHaveLength(1);
  });

  it('lets a question have more than one answer where it truly does', async () => {
    /*
     * French 10 is taught by two people. Both post its assignments, both mark
     * its work, and the vault said nothing at all about who teaches it --
     * because the relation had been declared to hold one answer, so two people
     * doing the job read as a contest and a contest withholds.
     *
     * It was doing what it was told. What it was told was wrong: co-teaching
     * is ordinary, and a shape that cannot hold it turns the commonest
     * arrangement in a school into silence.
     */
    const { llm } = fake([
      propose({
        answer: ['Lucia Coretti', 'Anna Marzilli'],
        confidence: 0.9,
        evidence: ['a-notice', 'b-notice'],
      }),
      propose({ refuted: false }),
    ]);

    const claims = await interpret({ llm }, question, { userId: 'u1' });
    expect(claims.map((c) => c.object).sort()).toEqual(['Anna Marzilli', 'Lucia Coretti']);
  });

  it('tells the refuter when a co-holder is not a rival', async () => {
    /*
     * Asked to break "Ken Nakamura teaches science", a refuter answered that
     * Anna Bell teaches part of it too, so the evidence does not uniquely
     * support Ken. Perfectly sound, and against a question that now admits
     * two answers it refuses the second one every time -- the rules it was
     * given were written when the relation held one.
     */
    const { llm, asked } = fake([
      propose({
        answer: ['Lucia Coretti', 'Anna Marzilli'],
        confidence: 0.9,
        evidence: ['a-notice'],
      }),
      propose({ refuted: false }),
    ]);
    await interpret({ llm }, { ...question, several: true }, { userId: 'u1' });

    for (const prompt of asked.slice(1)) {
      expect(prompt).toMatch(/more than one|another.*also|not a rival/i);
    }
  });

  it('drops a claim when the refuters disagree with each other', async () => {
    /*
     * One refuter is one sample of a judgement that is not deterministic, and
     * treating a single sample as a verdict is the same mistake as everything
     * else this file exists to stop -- one reading, promoted to settled.
     *
     * Measured under a hundred and twenty notices, a lone refuter caught the
     * cover-teacher case about two times in three. The other third shipped a
     * wrong teacher.
     *
     * Disagreement is contention, and contention withholds. That is the rule
     * settling already uses between rival readings of a slot; this is the same
     * rule applied to rival readings of one claim.
     */
    const { llm } = fake([
      propose({ answer: 'Lucia Coretti', confidence: 0.9, evidence: ['a-notice'] }),
      propose({ refuted: false }),
      propose({ refuted: true, why: 'She is covering the class, not teaching it.' }),
    ]);

    expect(await interpret({ llm }, question, { userId: 'u1' })).toEqual([]);
  });

  it('keeps a claim every refuter clears', async () => {
    const { llm, asked } = fake([
      propose({ answer: 'Lucia Coretti', confidence: 0.9, evidence: ['a-notice'] }),
      propose({ refuted: false }),
      propose({ refuted: false }),
    ]);

    const [claim] = await interpret({ llm }, question, { userId: 'u1' });
    expect(claim?.object).toBe('Lucia Coretti');
    // One proposal, and more than one attempt to break it.
    expect(asked.length).toBeGreaterThan(2);
  });

  it('drops a claim the refuter knocks down', async () => {
    /*
     * The French failure, and the step that was missing entirely. Both names
     * appear in this course's announcements; one is running a trip. A pass
     * whose only job is to find the hole finds it, where the pass that had
     * already committed to an answer would not.
     */
    const { llm } = fake([
      propose({ answer: 'Lucia Coretti', confidence: 0.8, evidence: ['a-notice'] }),
      propose({
        refuted: true,
        why: 'Marzilli is named in the same course and nothing separates them.',
      }),
    ]);

    expect(await interpret({ llm }, question, { userId: 'u1' })).toEqual([]);
  });

  it('refuses an answer that was never one of the candidates', async () => {
    /*
     * The house-versus-subject error in its purest form. Given a closed set of
     * people who could possibly be the answer, a name from outside it was not
     * read from anything -- it was assembled. This is decided here rather than
     * asked of a model, because a model that invented the name will happily
     * justify it.
     */
    const { llm } = fake([
      propose({ answer: 'Chris George', confidence: 0.95, evidence: ['a-notice'] }),
    ]);

    expect(await interpret({ llm }, question, { userId: 'u1' })).toEqual([]);
  });

  it('refuses a claim citing a note it was never shown', async () => {
    // Fabricated provenance is worse than none: it survives every check that
    // trusts the citation instead of resolving it.
    const { llm } = fake([
      propose({ answer: 'Lucia Coretti', confidence: 0.9, evidence: ['minutes-of-a-meeting'] }),
    ]);

    expect(await interpret({ llm }, question, { userId: 'u1' })).toEqual([]);
  });

  it('keeps a qualifier that appears in the evidence word for word', async () => {
    const { llm } = fake([
      propose({
        answer: 'Lucia Coretti',
        confidence: 0.9,
        evidence: ['a-notice'],
        qualifier: 'collect the essays',
      }),
      propose({ refuted: false }),
    ]);

    const [claim] = await interpret({ llm }, question, { userId: 'u1' });
    expect(claim?.qualifier).toBe('collect the essays');
  });

  it('drops a qualifier nobody wrote, and keeps the claim', async () => {
    /*
     * A qualifier is quoted, never composed. An invented one is the most
     * plausible-sounding thing a pass could produce -- it reads as care -- and
     * would be believed precisely because hedges are not the kind of sentence
     * anybody checks.
     */
    const { llm } = fake([
      propose({
        answer: 'Lucia Coretti',
        confidence: 0.9,
        evidence: ['a-notice'],
        qualifier: 'temporarily, while the department reorganises',
      }),
      propose({ refuted: false }),
    ]);

    const [claim] = await interpret({ llm }, question, { userId: 'u1' });
    expect(claim?.object).toBe('Lucia Coretti');
    expect(claim?.qualifier).toBeUndefined();
  });

  it('abstains when the proposal cannot be read at all', async () => {
    const { llm } = fake(['I think it is probably Mme Coretti, but I am not sure.']);
    expect(await interpret({ llm }, question, { userId: 'u1' })).toEqual([]);
  });

  it('carries the alternatives through, so settling can see the contest', async () => {
    const { llm } = fake([
      propose({
        answer: 'Lucia Coretti',
        confidence: 0.7,
        evidence: ['a-notice'],
        alternatives: ['Anna Marzilli'],
      }),
      propose({ refuted: false }),
    ]);

    const [claim] = await interpret({ llm }, question, { userId: 'u1' });
    expect(claim?.alternatives).toEqual(['Anna Marzilli']);
  });

  it('states whatever the narrowing guaranteed, in both prompts', () => {
    /*
     * The guarantees belong to whoever did the narrowing, not to this file.
     *
     * They were hardcoded here, phrased for courses and teachers, which made a
     * module that is supposed to answer any question able to answer only one
     * honestly -- ask it about a person and it would assure the model that
     * every quote was attached to that person "in the school records", which
     * is a sentence about courses and would have been a lie.
     *
     * Saying them at all is what matters. Leaving them unsaid cost almost
     * every true claim in the corpus: a refuter reading quotes that did not
     * happen to name the course objected, correctly on what it could see, that
     * "Mrs Bell set a practical assessment" never says the practical was
     * chemistry. It was refuting the shape of the evidence rather than the
     * claim, because the one fact that would have settled it was known to the
     * system and withheld from the reader.
     */
    return (async () => {
      const { llm, asked } = fake([
        propose({ answer: 'Lucia Coretti', confidence: 0.9, evidence: ['a-notice'] }),
        propose({ refuted: false }),
      ]);
      await interpret({ llm }, question, { userId: 'u1' });

      // The proposer and every attempt to break it.
      expect(asked.length).toBeGreaterThanOrEqual(2);
      for (const prompt of asked) {
        expect(prompt).toContain('Every quote below was taken from a note attached to french-10.');
      }
    })();
  });

  it('passes on what has already been settled, rather than asking again', () => {
    /*
     * A role decided once, from everything known about that person, beats the
     * same question re-answered from whatever fragment happens to be in front
     * of this one. It is also the only way the pass can know that somebody
     * doing the work of a teacher is on placement, since the sentence saying
     * so lives in a note about a different course.
     */
    return (async () => {
      const { llm, asked } = fake([propose({ answer: null })]);
      await interpret(
        { llm },
        { ...question, known: ['Anna Marzilli runs the exchange programme.'] },
        { userId: 'u1' },
      );

      expect(asked[0]).toContain('Anna Marzilli runs the exchange programme.');
    })();
  });

  it('tells the proposer that not answering is a good answer', async () => {
    const { llm, asked } = fake([propose({ answer: null })]);
    await interpret({ llm }, question, { userId: 'u1' });

    /*
     * The abstention contract has to reach the model, not merely be a thing
     * the codebase believes. What makes it work is the payoff being stated
     * outright -- declining is scored, not just permitted -- which is the
     * cheapest of the interventions and the one never tried here.
     */
    expect(asked[0]).toMatch(/declin\w* scores/i);
    expect(asked[0]).toMatch(/null` ?is a good answer|`null` is a good answer|null is a good/i);
  });
});
