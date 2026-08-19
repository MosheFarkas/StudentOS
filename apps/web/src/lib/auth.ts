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
    /*
     * Back to the page they were on, not the front door. A student who first
     * meets this app by clicking "Link this computer" is sent to Google from
     * /link/<id>; returning them to / would strand them on the agent list
     * while the desktop app sits polling for an approval that never comes.
     */
    callbackURL: window.location.href,
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
    // Back to Settings, where they pressed Connect.
    callbackURL: window.location.href,
  });
}
