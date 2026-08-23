import { isUnavailable } from './../tools/google/client.js';
import { readMail, searchMail } from '../tools/google/gmail.js';
import type { ToolContext } from '../tools/types.js';
import type { SchoolMessage } from './mail.js';

/**
 * Finding the school mail worth importing, and nothing else.
 *
 * An inbox is thousands of messages and nearly all of them are irrelevant, so
 * the question is not how to read them all but how to not. Three bounds, all
 * cheap and none of them involving a model:
 *
 *   Sender or recipient at the school's own domain, which is derived from the
 *   student's own address rather than configured. Classroom does not hand over
 *   teacher emails -- listCourses returns an id and a name and nothing else --
 *   so the domain is the only shared identifier available.
 *
 *   Recent, in windows. gmail_search caps at 25 results with no page token, so
 *   coverage comes from several dated queries rather than one crawl.
 *
 *   Capped in total, because the next step spends a model call per message and
 *   an import that surprises somebody with a bill is worse than a thin vault.
 */

/** Roughly one academic year, in months of lookback. */
const DEFAULT_MONTHS = 12;

/** gmail_search returns at most this many per call, and does not paginate. */
const PER_WINDOW = 25;

export interface MailCollectionOptions {
  /** e.g. "wearelcc.ca". Everything else is somebody else's problem. */
  domain: string;
  months?: number;
  /** Hard ceiling on messages whose bodies get fetched. */
  limit?: number;
}

export interface CollectedMail {
  messages: SchoolMessage[];
  /** Messages seen in search but not fetched, because the cap was reached. */
  overCap: number;
  skipped: string[];
}

interface SearchHit {
  messageId: string;
  from: string;
  subject: string;
  date: string;
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

export async function collectSchoolMail(
  ctx: ToolContext,
  options: MailCollectionOptions,
): Promise<CollectedMail> {
  const months = options.months ?? DEFAULT_MONTHS;
  const limit = options.limit ?? 40;
  const skipped: string[] = [];

  // Newest window first, so a cap that bites drops the oldest mail rather than
  // the mail that still matters.
  const hits = new Map<string, SearchHit>();
  for (let month = 0; month < months; month += 1) {
    const query =
      `(from:${options.domain} OR to:${options.domain}) ` +
      `newer_than:${month + 1}m older_than:${month}m`;

    let result: unknown;
    try {
      result = await searchMail.execute({ query, limit: PER_WINDOW } as never, ctx);
    } catch (error) {
      skipped.push(`search month -${month}: ${(error as Error).message}`);
      continue;
    }
    if (isUnavailable(result)) {
      skipped.push('gmail: not available (scope not granted, or not connected)');
      break;
    }

    for (const hit of (result as { messages?: SearchHit[] }).messages ?? []) {
      if (!hits.has(hit.messageId)) hits.set(hit.messageId, hit);
    }
  }

  const wanted = [...hits.values()].slice(0, limit);

  const messages: SchoolMessage[] = [];
  for (const hit of wanted) {
    let full: unknown;
    try {
      full = await readMail.execute({ messageId: hit.messageId } as never, ctx);
    } catch (error) {
      skipped.push(`read ${hit.messageId}: ${(error as Error).message}`);
      continue;
    }
    if (isUnavailable(full)) continue;

    const body = (full as { body?: string }).body ?? '';
    messages.push({
      messageId: hit.messageId,
      from: hit.from,
      subject: hit.subject,
      date: hit.date,
      body,
    });
  }

  return { messages, overCap: Math.max(0, hits.size - wanted.length), skipped };
}
