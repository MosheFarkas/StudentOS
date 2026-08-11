import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import type { Database } from '@studentos/db';
import * as schema from '@studentos/db/schema';
import { IDENTITY_SCOPES } from '@studentos/agent';
import type { Env } from './env.js';

/**
 * Auth configuration.
 *
 * Two decisions here are load-bearing and easy to undo by accident:
 *
 * 1. The bearer plugin is enabled. Cookie sessions are fine for the web SPA,
 *    but a desktop shell talking to this API from a different origin is painful
 *    with cookies and trivial with a bearer token. Removing this plugin closes
 *    the door on the Mac app.
 *
 * 2. Google sign-in requests IDENTITY SCOPES ONLY. Calendar and Classroom are
 *    requested later, separately, when a student actually connects them --
 *    see requestAdditionalScopes below. Adding them here would put every scope
 *    on the first-run consent screen, which converts badly and, for managed
 *    under-18 accounts, can block sign-in outright.
 *    Read packages/agent/src/tools/google/scopes.ts before changing this.
 */
export function createAuth(db: Database, env: Env) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    baseURL: env.API_BASE_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.WEB_BASE_URL],

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: [...IDENTITY_SCOPES],
        // Required to receive a refresh token. Without both of these, the
        // access token expires in an hour and background jobs (calendar sync,
        // memory summarisation) stop working with no obvious cause.
        accessType: 'offline',
        prompt: 'consent',
      },
    },

    plugins: [bearer()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/*
 * Incremental authorisation, as built:
 *
 *   1. Student clicks Connect in Settings (web: screens/GoogleConnections).
 *   2. Client asks GET /api/google/connect-scopes/:group for the scope list --
 *      the server returns the UNION of what is already granted plus the new
 *      group, which prevents the new token from dropping the old scopes.
 *   3. Client calls linkSocial with that list; Google redirects back and
 *      Better Auth updates `scope` and the tokens on the account row.
 *   4. getGrantedGroups (google/connections.ts) reads that scope string, and
 *      buildToolRegistry registers only the matching tools for that student.
 *
 * Token refresh is Better Auth's: auth.api.getAccessToken refreshes from the
 * stored refresh token, which is why accessType/prompt are set above.
 *
 * TODO(desktop): the Mac shell cannot host the redirect itself. Open the
 * system browser to the normal web flow, then hand the session back via a deep
 * link (studentos://auth?token=...). That is why the bearer plugin is on.
 */
