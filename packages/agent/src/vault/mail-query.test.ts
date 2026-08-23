import { describe, expect, it } from 'vitest';
import { schoolMailQuery } from './mail-query.js';

/**
 * Which mail counts as school mail.
 *
 * Found by running against a real account: the query was
 * `from:school.ca OR to:school.ca`, and since the student's own address is at
 * that domain, `to:` matched every message ever sent to them. The filter
 * filtered nothing. It listed two thousand messages -- the ceiling, not the
 * answer -- and would have spent a model call on each.
 */

describe('the school mail query', () => {
  const query = schoolMailQuery('wearelcc.ca', 12);

  it('matches mail sent from the school domain', () => {
    expect(query).toContain('from:wearelcc.ca');
  });

  it('does not match everything addressed to the student', () => {
    /*
     * The whole bug. A student at wearelcc.ca receives their marketing, their
     * receipts and their personal mail at that address too, so `to:` on their
     * own domain selects the inbox rather than the school.
     */
    expect(query).not.toContain('to:wearelcc.ca');
  });

  it('bounds how far back it looks', () => {
    expect(query).toContain('newer_than:12m');
    expect(schoolMailQuery('wearelcc.ca', 3)).toContain('newer_than:3m');
  });

  it('leaves out spam and the bin', () => {
    // Otherwise a spam folder full of spoofed school addresses is imported as
    // though a teacher had sent it.
    expect(query).toContain('-in:spam');
    expect(query).toContain('-in:trash');
  });
});
