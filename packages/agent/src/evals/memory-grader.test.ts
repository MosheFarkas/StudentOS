import { describe, expect, it } from 'vitest';
import { gradeReply } from './memory-grader.js';

/**
 * Tests for the memory grader.
 *
 * Same argument as rules.test.ts: an eval is only as good as its instrument,
 * and here the instrument decides whether the agent remembered something. The
 * failure that matters is a grader that passes a reply which did not actually
 * recall the fact -- it would report memory working exactly when it is not,
 * and there would be nothing to notice.
 */

const base = { id: 'c1', category: 'extraction' as const, history: [], question: 'q' };

describe('checking for a recalled fact', () => {
  it('passes when every expected term is present', () => {
    const result = gradeReply(
      { ...base, expect: ['Ali', 'chemistry'] },
      'Mr Ali teaches chemistry.',
    );
    expect(result.passed).toBe(true);
  });

  it('fails when a term is missing, and names which one', () => {
    const result = gradeReply({ ...base, expect: ['Ali', 'chemistry'] }, 'Your chemistry teacher.');
    expect(result.passed).toBe(false);
    expect(result.why).toContain('Ali');
  });

  it('ignores case', () => {
    expect(gradeReply({ ...base, expect: ['ALI'] }, 'mr ali').passed).toBe(true);
  });

  it('matches whole words only', () => {
    // "Alison" contains "Ali". Substring matching would score a wrong name as
    // a correct recall, which is the exact failure this eval exists to catch.
    expect(gradeReply({ ...base, expect: ['Ali'] }, 'Alison teaches you.').passed).toBe(false);
    expect(gradeReply({ ...base, expect: ['Ali'] }, 'Mr Ali teaches you.').passed).toBe(true);
  });

  it('matches a multi-word term', () => {
    expect(gradeReply({ ...base, expect: ['past papers'] }, 'Do the past papers.').passed).toBe(
      true,
    );
  });
});

describe('checking a superseded fact is not repeated', () => {
  it('fails when the stale answer appears', () => {
    // The knowledge-update category: they changed teacher. Naming the old one
    // is the failure, even if the new one is named too.
    const result = gradeReply(
      { ...base, category: 'update', expect: ['Okonkwo'], reject: ['Ali'] },
      'It was Mr Ali, now Ms Okonkwo.',
    );
    expect(result.passed).toBe(false);
    expect(result.why).toMatch(/stale|reject/i);
  });

  it('allows naming the old answer while explaining it changed', () => {
    // A real reply from the eval: "Ms Okonkwo teaches you chemistry now. Mr Ali
    // left at half term." That is the correct answer plus useful context, and
    // scoring it as a failure punishes the agent for being helpful.
    const result = gradeReply(
      { ...base, category: 'update', expect: ['Okonkwo'], reject: ['Ali'] },
      'Ms Okonkwo teaches you chemistry now. Mr Ali left at half term.',
    );
    expect(result.passed).toBe(true);
  });

  it('passes when only the current answer appears', () => {
    const result = gradeReply(
      { ...base, category: 'update', expect: ['Okonkwo'], reject: ['Ali'] },
      'Ms Okonkwo teaches you chemistry.',
    );
    expect(result.passed).toBe(true);
  });
});

describe('checking it declines to invent', () => {
  it('passes when the reply admits it was never told', () => {
    for (const reply of [
      "I don't know -- you haven't told me that.",
      'You never mentioned a music teacher.',
      'I have no record of that.',
      "I can't find anything about that in what you've told me.",
      'Not sure, sorry.',
    ]) {
      expect(gradeReply({ ...base, category: 'abstention', abstain: true }, reply).passed).toBe(
        true,
      );
    }
  });

  it('accepts a typographic apostrophe, which is what models actually emit', () => {
    // The first run of this eval scored three correct abstentions as failures
    // because the model wrote "don\u2019t" and the pattern matched "don't".
    expect(
      gradeReply(
        { ...base, category: 'abstention', abstain: true },
        '\u2018I don\u2019t have your music teacher\u2019s name saved.\u2019',
      ).passed,
    ).toBe(true);
  });

  it('fails when the reply confidently invents an answer', () => {
    const result = gradeReply(
      { ...base, category: 'abstention', abstain: true },
      'Your music teacher is Mr Harrison.',
    );
    expect(result.passed).toBe(false);
    expect(result.why).toMatch(/abstain|invent|admit/i);
  });

  it('fails a reply that answers and then hedges', () => {
    // "It's probably Mr Harrison, though I'm not sure" is confabulation with a
    // disclaimer attached. A student acts on the name.
    const result = gradeReply(
      { ...base, category: 'abstention', abstain: true },
      "It's Mr Harrison, though I'm not sure.",
    );
    expect(result.passed).toBe(false);
  });
});
