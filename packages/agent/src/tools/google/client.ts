import { unavailable, type ToolUnavailable } from '../types.js';

/**
 * Shared Google API caller.
 *
 * Exists mainly for the error mapping below. Google returns 403 for several
 * completely different situations, and telling a student "something went
 * wrong" when the real answer is "your school has to approve this app" sends
 * them into a retry loop they cannot win.
 */
export interface GoogleRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function googleFetch<T>(
  url: string,
  accessToken: string,
  options: GoogleRequest = {},
): Promise<T | ToolUnavailable> {
  const { method = 'GET', body, signal } = options;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });

  if (response.ok) {
    // DELETE returns 204 with an empty body -- json() would throw on it.
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }

  const errorBody = (await response.json().catch(() => null)) as GoogleErrorBody | null;
  const reason = errorBody?.error?.errors?.[0]?.reason ?? errorBody?.error?.status ?? '';
  const message = errorBody?.error?.message ?? `HTTP ${response.status}`;

  switch (reason) {
    /*
     * The Workspace admin has not configured this app, or has blocked it.
     *
     * For an under-18 Education account this is the default state, not an
     * exception -- see scopes.ts. There is nothing the student can do from
     * inside the product, so say so plainly rather than offering a retry.
     */
    case 'accessNotConfigured':
    case 'access_not_configured':
      return unavailable(
        'Your school has not approved Contexto yet, so this cannot be used. ' +
          'An administrator needs to allow the app before it will work.',
      );

    case 'adminPolicyEnforced':
    case 'admin_policy_enforced':
      return unavailable(
        'Your school has blocked Contexto from accessing this. ' +
          'An administrator would need to change that.',
      );

    /* The token is stale or the scope was revoked. Reconnecting fixes it. */
    case 'authError':
    case 'UNAUTHENTICATED':
      return unavailable('Your Google connection expired. Reconnect it in Settings.');

    case 'insufficientPermissions':
    case 'PERMISSION_DENIED':
      return unavailable(
        'Contexto does not have permission for this. Reconnect Google in Settings ' +
          'to grant it.',
      );

    /*
     * Quota. Retrying immediately makes it worse, so do not suggest it.
     * A real fix is backoff at the caller, once there is enough traffic to
     * warrant it.
     */
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
    case 'RESOURCE_EXHAUSTED':
      return unavailable('Google is rate limiting us right now. Try again in a minute.');

    default:
      if (response.status === 404) {
        return unavailable('That Google resource does not exist or is not shared with you.');
      }
      return unavailable(`Google returned an error: ${message}`);
  }
}

interface GoogleErrorBody {
  error?: {
    status?: string;
    message?: string;
    errors?: { reason?: string }[];
  };
}

export function isUnavailable(value: unknown): value is ToolUnavailable {
  return typeof value === 'object' && value !== null && 'unavailable' in value;
}
