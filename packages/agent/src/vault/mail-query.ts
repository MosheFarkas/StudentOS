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
export function schoolMailQuery(domain: string, months: number): string {
  return `from:${domain} newer_than:${months}m -in:spam -in:trash`;
}
