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
 * Long enough at the end to ride out a saturated minute rather than one
 * unlucky call: the token limit is per minute and an import is hundreds of
 * calls, so the work sits against the ceiling for a while. This is what
 * regulates it down to the rate actually allowed; concurrency only decides how
 * far past the ceiling it reaches first.
 */
const BACKOFF = [500, 2000, 6000, 15_000];

export async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const wait = BACKOFF[attempt];
      if (wait === undefined || !worthRetrying(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
