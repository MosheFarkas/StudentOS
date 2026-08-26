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

/** A scripted model. Each reply is returned in order, and calls are recorded. */
function fake(replies: string[]) {
  const asked: string[] = [];
  return {
    asked,
    llm: {
      chat: async (request: { messages: { role: string; content: string }[] }) => {
        asked.push(request.messages.map((m) => m.content).join('\n'));
        return { content: replies[asked.length - 1] ?? '', toolCalls: [] } as never;
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

    const claim = await interpret({ llm }, question, { userId: 'u1' });
    expect(claim?.object).toBe('Lucia Coretti');
    expect(claim?.basis).toBe('inferred');
    expect(claim?.evidence[0]?.note).toBe('a-notice');
  });

  it('returns nothing when the proposal abstains', async () => {
    const { llm, asked } = fake([propose({ answer: null, why: 'Two names, no way to choose.' })]);

    expect(await interpret({ llm }, question, { userId: 'u1' })).toBeNull();
    // And does not pay for a refutation of a claim nobody made.
    expect(asked).toHaveLength(1);
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

    expect(await interpret({ llm }, question, { userId: 'u1' })).toBeNull();
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

    expect(await interpret({ llm }, question, { userId: 'u1' })).toBeNull();
  });

  it('refuses a claim citing a note it was never shown', async () => {
    // Fabricated provenance is worse than none: it survives every check that
    // trusts the citation instead of resolving it.
    const { llm } = fake([
      propose({ answer: 'Lucia Coretti', confidence: 0.9, evidence: ['minutes-of-a-meeting'] }),
    ]);

    expect(await interpret({ llm }, question, { userId: 'u1' })).toBeNull();
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

    const claim = await interpret({ llm }, question, { userId: 'u1' });
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

    const claim = await interpret({ llm }, question, { userId: 'u1' });
    expect(claim?.object).toBe('Lucia Coretti');
    expect(claim?.qualifier).toBeUndefined();
  });

  it('abstains when the proposal cannot be read at all', async () => {
    const { llm } = fake(['I think it is probably Mme Coretti, but I am not sure.']);
    expect(await interpret({ llm }, question, { userId: 'u1' })).toBeNull();
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

    const claim = await interpret({ llm }, question, { userId: 'u1' });
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

      expect(asked).toHaveLength(2);
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
