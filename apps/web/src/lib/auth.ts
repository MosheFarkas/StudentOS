import { createAuthClient } from 'better-auth/react';
import { API_BASE_URL } from './env.js';

/**
 * Auth client.
 *
 * `credentials: 'include'` is what sends the session cookie cross-origin
 * (the SPA and API are on different ports in dev, and likely different
 * subdomains in production).
 *
 * TODO(desktop): the Mac shell will need the bearer-token path instead of
 * cookies -- store the token in the OS keychain and set an Authorization
 * header here. The API already accepts both (see apps/api/src/auth.ts).
 */
export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  fetchOptions: {
    credentials: 'include',
  },
});

export const { useSession, signIn, signOut, linkSocial } = authClient;

/** Sign in with Google, requesting identity scopes only. */
export function signInWithGoogle() {
  return signIn.social({
    provider: 'google',
    callbackURL: window.location.origin,
  });
}

/**
 * Grant an additional Google scope group.
 *
 * `scopes` must be the UNION of everything already granted plus the new group,
 * which is why it comes from the server (GET /google/connect-scopes/:group)
 * rather than being hardcoded here. Requesting only the new group's scopes
 * returns a token that no longer covers the old ones -- see the comment on
 * that route.
 */
export function connectGoogleScopes(scopes: string[]) {
  return linkSocial({
    provider: 'google',
    scopes,
    callbackURL: window.location.origin,
  });
}
