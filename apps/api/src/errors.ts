import type { Context } from 'hono';
import { ZodError } from 'zod';
import { ContextoError, type ApiError } from '@contexto/shared';

/**
 * Maps thrown errors to the documented response shape.
 *
 * Lives here rather than inline in index.ts so anything that mounts the routes
 * gets identical behaviour -- including tests. When this was part of server
 * bootstrap, a test harness saw 500s where the real server returned 404s, which
 * is exactly the kind of divergence that makes a passing suite worthless.
 */
export function handleError(error: unknown, c: Context): Response {
  if (error instanceof ContextoError) {
    const body: ApiError = { code: error.code, message: error.message };
    return c.json(body, statusFor(error.code));
  }

  if (error instanceof ZodError) {
    const body: ApiError = {
      code: 'validation_failed',
      message: error.issues[0]?.message ?? 'Invalid request.',
    };
    return c.json(body, 400);
  }

  // Never surface an unexpected error's message -- decryption failures and
  // upstream provider errors can carry key material.
  console.error('Unhandled error', error);
  const body: ApiError = { code: 'internal_error', message: 'Something went wrong.' };
  return c.json(body, 500);
}

function statusFor(code: ApiError['code']): 400 | 401 | 402 | 404 | 500 {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'not_found':
      // Deliberately not 403. A 403 confirms the resource exists, which leaks
      // that some id belongs to somebody.
      return 404;
    case 'validation_failed':
    case 'provider_key_invalid':
      return 400;
    case 'quota_exceeded':
    case 'no_provider_configured':
      return 402;
    default:
      return 500;
  }
}
