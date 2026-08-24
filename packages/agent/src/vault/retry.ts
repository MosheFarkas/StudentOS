/**
 * Going back for something that failed for a reason unrelated to itself.
 *
 * A rate limit and a 5xx are the provider saying "come back shortly". Treating
 * either as a verdict on the work throws away a message or a file for a reason
 * that has nothing to do with it -- and against a per-minute token limit, a
 * long import spends most of its life there.
 *
 * Measured twice. A mail import of 667 messages died outright on one 429,
 * discarding 599 extractions already paid for. Then a file reader without this
 * failed 196 of 512 files, and retrying twenty of those by hand succeeded on
 * sixteen: almost none of it was about the files.
 *
 * It lives here because it was written for the mail pass, was exactly what the
 * file pass needed, and was not there -- one copy is the only version of this
 * that stays true of both.
 */

export function worthRetrying(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  return /\b429\b|rate.?limit|\b5\d\d\b|timeout|ECONNRESET|ETIMEDOUT/i.test(
    (error as Error)?.message ?? '',
  );
}

/*
 * Backoff between attempts, in milliseconds.
 *
 * The last two steps are long because the token limit resets on a rolling
 * minute. A backoff that gives up inside one can never clear a saturated
 * budget, which is exactly what happened: two full passes over a real vault
 * failed 38% and then 43% of their files, and every sampled one read fine on
 * a later attempt. Four tries over twenty-three seconds was never going to
 * outlast a limit measured over sixty.
 */
const BACKOFF = [1000, 5000, 20_000, 45_000, 60_000];

/** Never park an import on a malformed or hostile hint. */
const LONGEST = 90_000;

/**
 * How long to wait before attempt number `attempt`, or null to give up.
 *
 * The provider usually says: "Please try again in 28.878s". Guessing shorter
 * than that is simply spending an attempt to be told the same thing again, so
 * a stated wait always wins over the schedule -- with a margin, because coming
 * back a moment early is another refusal.
 */
export function waitFor(error: unknown, attempt: number): number | null {
  const step = BACKOFF[attempt];
  if (step === undefined) return null;

  const asked = suggestedWait(error);
  return Math.min(LONGEST, Math.max(step, asked === null ? 0 : asked * 1.1 + 250));
}

/** The wait named in the provider's own message, in milliseconds. */
function suggestedWait(error: unknown): number | null {
  const message = (error as Error)?.message ?? '';
  const seconds = /try again in ([\d.]+)\s*s\b/i.exec(message);
  if (seconds?.[1]) return Number(seconds[1]) * 1000;

  const millis = /try again in ([\d.]+)\s*ms\b/i.exec(message);
  if (millis?.[1]) return Number(millis[1]);

  const header = (error as { headers?: { get?: (k: string) => string | null } })?.headers?.get?.(
    'retry-after',
  );
  if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;

  return null;
}

export async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const wait = worthRetrying(error) ? waitFor(error, attempt) : null;
      if (wait === null) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
