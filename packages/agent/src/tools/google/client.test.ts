import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleFetch } from './client.js';

/**
 * Error mapping only.
 *
 * These messages are the entire product surface of a failure -- a student
 * never sees a status code, only the sentence we choose. The bodies below are
 * Google's real shapes, because the mapping keys off fields whose exact names
 * are easy to guess wrong.
 */
function stub(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

const reasonOf = async (): Promise<string> => {
  const result = await googleFetch<unknown>('https://example.test', 'token');
  return (result as { reason: string }).reason;
};

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('accessNotConfigured', () => {
  /**
   * Google reuses one reason code for two unrelated causes. Blaming the
   * school for our own unenabled API sends a student to their IT department
   * over a checkbox in our Cloud console -- a support burden that lands on
   * the person least able to fix it.
   */
  it('blames us, not the school, when the API is not enabled in our project', async () => {
    stub(403, {
      error: {
        code: 403,
        message:
          'Google Drive API has not been used in project 12345 before or it is disabled. ' +
          'Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview',
        errors: [{ reason: 'accessNotConfigured' }],
      },
    });

    const reason = await reasonOf();
    expect(reason).toContain('on us');
    expect(reason).not.toContain('school has not approved');
  });

  it('blames the admin when the app is genuinely not approved', async () => {
    stub(403, {
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        errors: [{ reason: 'accessNotConfigured' }],
      },
    });

    const reason = await reasonOf();
    expect(reason).toContain('school has not approved');
  });
});

describe('other failures', () => {
  it('tells the student to reconnect on an expired token', async () => {
    stub(401, { error: { status: 'UNAUTHENTICATED', message: 'Invalid Credentials' } });
    expect(await reasonOf()).toContain('Reconnect');
  });

  it('does not suggest retrying into a rate limit', async () => {
    stub(429, {
      error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] },
    });
    const reason = await reasonOf();
    expect(reason).toContain('rate limiting');
  });

  it('survives an error body that is not JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>502</html>', { status: 502 }));
    expect(await reasonOf()).toContain('Google returned an error');
  });
});
