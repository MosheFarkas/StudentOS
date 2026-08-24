/**
 * Which mail is school mail.
 *
 * The first version asked for `from:<domain> OR to:<domain>` and looked
 * obviously right. It is not: the student's own address is at that domain, so
 * `to:` matches every message ever sent to them -- their marketing, their
 * receipts, their personal mail. The filter filtered nothing. Run against a
 * real account it listed two thousand messages, which was the ceiling rather
 * than the answer, and would have spent a model call on each of them.
 *
 * `from:` alone is the honest filter. Mail written by somebody at the school,
 * plus the student's own sent mail, which is also from that domain and is also
 * school correspondence. Everything sent *to* them by the outside world falls
 * away, which is the entire point.
 *
 * What this deliberately loses: Classroom's own notification mail, which comes
 * from no-reply@classroom.google.com. That is not a loss. Those messages say an
 * assignment was posted or a grade came back, and the Classroom API already
 * supplies both directly -- the writing rules call that one event seen twice.
 */
export function schoolMailQuery(domains: string[], months: number): string {
  const from = domains.map((domain) => `from:${domain}`).join(' OR ');
  // Parenthesised because Gmail binds OR tighter than the implicit AND, and
  // without them `newer_than` would apply to the last domain alone.
  return `(${from}) newer_than:${months}m -in:spam -in:trash`;
}

/**
 * Where a student writes personal mail. Not evidence of a school.
 *
 * Deliberately a short list of the consumer hosts rather than an attempt to
 * classify domains in general: everything here is a place a person has a
 * private address, and anything not here that a student writes to repeatedly
 * is something in their life worth knowing about.
 */
const PERSONAL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.ca',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

/** Below this, writing to a domain is a one-off rather than a relationship. */
const ENOUGH_TO_COUNT = 2;

/**
 * The domains a school uses, from the student's own address and their sent mail.
 *
 * A school having exactly one domain was an assumption, and on the first real
 * account it was wrong: students are at one domain and staff are at another.
 * That gap was 462 messages against the 205 being imported -- most of the
 * student's actual correspondence with their school, missing without a word.
 *
 * Classroom knows the staff addresses and will not say without a roster scope
 * the school itself would have to approve, which is not a thing to go and take.
 * Who the student writes to needs no new permission and is better evidence
 * anyway: a domain they have chosen to email more than once is a relationship,
 * where a domain that merely emails them is a mailing list.
 */
export function schoolDomains(ownAddress: string, sentTo: string[]): string[] {
  const own = ownAddress.split('@')[1]?.toLowerCase();
  if (!own) return [];

  const howOften = new Map<string, number>();
  for (const address of sentTo) {
    const domain = address.toLowerCase();
    if (domain === own || PERSONAL.has(domain)) continue;
    howOften.set(domain, (howOften.get(domain) ?? 0) + 1);
  }

  const also = [...howOften.entries()]
    .filter(([, count]) => count >= ENOUGH_TO_COUNT)
    .sort((a, b) => b[1] - a[1])
    .map(([domain]) => domain);

  return [own, ...also];
}
