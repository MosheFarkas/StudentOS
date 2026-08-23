import { isUnavailable } from '../tools/google/client.js';
import { listAllMessageIds, readMail } from '../tools/google/gmail.js';
import type { ToolContext } from '../tools/types.js';
import { schoolMailQuery } from './mail-query.js';
import type { SchoolMessage } from './mail.js';

/**
 * Finding every school message, and reading only the ones worth reading.
 *
 * The first version capped the import at forty messages because extraction
 * costs a model call each, and separately relied on gmail_search, which
 * returns twenty-five and does not page. Between them the vault got a slice of
 * the year and no way to tell which slice -- the busy months were the ones
 * being truncated, and those are the months with the schoolwork in them.
 *
 * Coverage and cost are separate problems and are now solved separately.
 * Listing pages through the whole query, so nothing is invisible.
 *
 * Fetching is complete too. Gmail's list returns bare ids, so a per-message
 * request is unavoidable either way, and the expensive part of the import was
 * never the fetch -- it is the model call that follows. That is what stays
 * bounded, by concurrency and by the pass's own judgement of what is worth
 * keeping, rather than by an arbitrary ceiling on how much of the year the
 * student is allowed to have.
 */

/**
 * Ceiling on ids listed.
 *
 * A guard against a pathological inbox, never a sample. Reaching it means the
 * query is wrong rather than that the student is unusual -- which is exactly
 * what happened the first time: a broken filter listed two thousand messages
 * and the number looked like a finding instead of a ceiling. Hitting it is
 * reported loudly now, and the caller is expected to stop.
 */
const MAX_IDS = 600;

export interface MailCollectionOptions {
  /** e.g. "wearelcc.ca". Everything else is somebody else's problem. */
  domain: string;
  /** How far back to look, in months. */
  months?: number;
  /** Ceiling on ids listed, for an inbox far outside the ordinary. */
  maxIds?: number;
}

export interface CollectedMail {
  messages: SchoolMessage[];
  /** How many ids were listed, so a truncated fetch is visible. */
  found: number;
  /** True when listing stopped at the ceiling, so the result is incomplete. */
  hitCeiling: boolean;
  skipped: string[];
}

/** The student's own domain, which is the school's. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  const domain =
    at === -1
      ? ''
      : email
          .slice(at + 1)
          .trim()
          .toLowerCase();
  // A student on gmail.com has no school domain to filter by, and importing
  // everything from gmail.com would be the entire inbox.
  const personal = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'];
  return domain === '' || personal.includes(domain) ? null : domain;
}

/** Every school message in the window. */
export async function collectSchoolMail(
  ctx: ToolContext,
  options: MailCollectionOptions,
): Promise<CollectedMail> {
  const skipped: string[] = [];
  const query = `(from:${options.domain} OR to:${options.domain}) newer_than:${options.months ?? 12}m`;

  const ids = await listAllMessageIds(ctx, query, options.maxIds ?? MAX_IDS);
  if (isUnavailable(ids)) {
    return {
      messages: [],
      found: 0,
      hitCeiling: false,
      skipped: ['gmail: not available (scope not granted, or not connected)'],
    };
  }

  const ceiling = options.maxIds ?? MAX_IDS;
  const hitCeiling = ids.length >= ceiling;

  /*
   * A ceiling reached is a broken query, not a busy student.
   *
   * Returned before anything is fetched, so a wrong filter costs one listing
   * rather than six hundred requests and six hundred model calls.
   */
  if (hitCeiling) {
    return {
      messages: [],
      found: ids.length,
      hitCeiling: true,
      skipped: [
        `listing stopped at ${ceiling} messages, which means the query is too broad -- ` +
          'nothing was fetched',
      ],
    };
  }

  const messages: SchoolMessage[] = [];
  for (const messageId of ids) {
    let full: unknown;
    try {
      full = await readMail.execute({ messageId } as never, ctx);
    } catch (error) {
      skipped.push(`read ${messageId}: ${(error as Error).message}`);
      continue;
    }
    if (isUnavailable(full)) continue;

    const message = full as { from?: string; subject?: string; date?: string; body?: string };
    messages.push({
      messageId,
      from: message.from ?? '',
      subject: message.subject ?? '',
      date: message.date ?? '',
      body: message.body ?? '',
    });
  }

  return { messages, found: ids.length, hitCeiling, skipped };
}
