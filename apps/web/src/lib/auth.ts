import { createAuthClient } from 'better-auth/react';

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
  baseURL: import.meta.env.VITE_API_BASE_URL,
  fetchOptions: {
    credentials: 'include',
  },
});

export const { useSession, signIn, signOut } = authClient;

/** Sign in with Google, requesting identity scopes only. */
export function signInWithGoogle() {
  return signIn.social({
    provider: 'google',
    callbackURL: window.location.origin,
  });
}
