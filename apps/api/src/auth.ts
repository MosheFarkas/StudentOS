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
 * TODO(oauth): incremental authorisation for Calendar and Classroom.
 *
 * Flow, once implemented:
 *   1. Student clicks "Connect Google Calendar" in the web app.
 *   2. Client calls Better Auth's linkSocial with the calendar scope group
 *      (see scopesFor(['calendar']) in @studentos/agent).
 *   3. Google returns an updated `scope` on the account row.
 *   4. grantedScopeGroups(account.scope) then reports 'calendar', and the
 *      agent's tool registry includes the calendar tools for that student.
 *
 * Classroom is the same flow with a different group, and must stay independent
 * -- a student who cannot get Classroom approved should still be able to use
 * Calendar and everything else.
 *
 * DESKTOP: the Mac shell cannot host the redirect itself. Open the system
 * browser to the normal web flow, then hand the session back via a deep link
 * (studentos://auth?token=...). That is why the bearer plugin is on.
 */
