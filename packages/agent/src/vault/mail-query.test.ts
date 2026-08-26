import { describe, expect, it } from 'vitest';
import { schoolDomains, schoolMailQuery } from './mail-query.js';

describe('which mail is school mail', () => {
  it('asks only for mail written by the school', () => {
    /*
     * The first version asked for `from:<domain> OR to:<domain>`, and since the
     * student's own address is at that domain it matched every message ever
     * sent to them. On a real account it returned two thousand, which was the
     * ceiling rather than the answer.
     */
    const query = schoolMailQuery(['wearelcc.ca'], 12);
    expect(query).toContain('from:wearelcc.ca');
    expect(query).not.toContain('to:wearelcc.ca');
  });

  it('asks for every domain the school uses', () => {
    // A school having one domain was an assumption, and on the first real
    // account it was wrong: students are @wearelcc.ca and staff are @lcc.ca.
    const query = schoolMailQuery(['wearelcc.ca', 'lcc.ca'], 12);
    expect(query).toContain('from:wearelcc.ca');
    expect(query).toContain('from:lcc.ca');
    expect(query).toContain(' OR ');
  });

  it('leaves out spam and the bin', () => {
    expect(schoolMailQuery(['wearelcc.ca'], 12)).toContain('-in:spam');
    expect(schoolMailQuery(['wearelcc.ca'], 12)).toContain('-in:trash');
  });

  it('asks only as far back as it was told to', () => {
    expect(schoolMailQuery(['wearelcc.ca'], 12)).toContain('newer_than:12m');
    expect(schoolMailQuery(['wearelcc.ca'], 3)).toContain('newer_than:3m');
  });

  it('asks for Classroom\u2019s own notification mail', () => {
    /*
     * This was excluded on purpose, and the reasoning was wrong.
     *
     * The note said those messages only repeat what the Classroom API already
     * supplies -- an assignment posted, a grade returned -- and called it one
     * event seen twice. The API supplies the event. It does not supply who
     * posted it: the creator comes back as an opaque user id that cannot be
     * turned into a name without a roster scope nobody has requested.
     *
     * The notification's sender line is "Chris George (Classroom)". It is the
     * one place in the whole system where a teacher's name sits next to the
     * course they posted in, and it was the single thing being filtered out.
     */
    expect(schoolMailQuery(['lcc.ca'], 12)).toContain('classroom.google.com');
  });
});

describe('working out which domains are the school', () => {
  /*
   * Deriving the school from the student's own address misses any second
   * domain, and on the first real account that was 462 messages -- more than
   * twice what was being imported. Classroom knows the staff addresses but
   * will not say without a roster scope the school would have to approve.
   *
   * What needs no permission at all: who the student writes to. A domain they
   * have sent mail to repeatedly is a relationship, not a guess.
   */
  const own = 'lyliu@wearelcc.ca';

  it('always includes the domain the student is at', () => {
    expect(schoolDomains(own, [])).toEqual(['wearelcc.ca']);
  });

  it('finds the second domain a school uses', () => {
    const sent = [...Array(45).fill('lcc.ca'), ...Array(34).fill('wearelcc.ca')];
    expect(schoolDomains(own, sent).sort()).toEqual(['lcc.ca', 'wearelcc.ca']);
  });

  it('leaves personal mail out of it', () => {
    // A student writing to their own family is not evidence of a school.
    const sent = [...Array(20).fill('gmail.com'), ...Array(20).fill('yahoo.com')];
    expect(schoolDomains(own, sent)).toEqual(['wearelcc.ca']);
  });

  it('ignores a domain written to once', () => {
    // One reply to one shop is not a school, and every domain it wrongly
    // admits costs a model call per message that domain ever sent.
    expect(schoolDomains(own, ['ticketvendor.com', 'lcc.ca', 'lcc.ca', 'lcc.ca'])).toEqual([
      'wearelcc.ca',
      'lcc.ca',
    ]);
  });

  it('does not list the same domain twice', () => {
    const sent = Array(10).fill('wearelcc.ca');
    expect(schoolDomains(own, sent)).toEqual(['wearelcc.ca']);
  });

  it('copes with an address it cannot make sense of', () => {
    expect(schoolDomains('not-an-address', [])).toEqual([]);
  });
});
