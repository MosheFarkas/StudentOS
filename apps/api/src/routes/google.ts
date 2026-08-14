import { Hono } from 'hono';
import { SCOPE_GROUPS, missingOptionalScopes, scopesFor, type ScopeGroup } from '@contexto/agent';
import type { AppContext } from '../context.js';
import { getGoogleGrant } from '../google/connections.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';

/**
 * Google connection status.
 *
 * The linking itself happens client-side through Better Auth's linkSocial,
 * which needs to run in the browser to handle the redirect. What the server
 * owns is telling the client WHICH scopes to ask for -- see the union note on
 * /connect-scopes below, which is the part that is easy to get wrong.
 */
export function createGoogleRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);

  return (
    new Hono<{ Variables: AuthVariables }>()
      .get('/status', auth, async (c) => {
        const grant = await getGoogleGrant(ctx.db, c.get('userId'));

        // Missing optional scopes are surfaced, not swallowed. A school that
        // approves a subset produces a connection that works partially, and
        // the student deserves to know which pieces their admin withheld
        // rather than meeting a tool that silently never fires.
        return c.json({
          calendar: grant.groups.includes('calendar'),
          classroom: grant.groups.includes('classroom'),
          missing: {
            calendar: missingOptionalScopes('calendar', grant.scope),
            classroom: missingOptionalScopes('classroom', grant.scope),
          },
        });
      })

      /**
       * The scope list the client should request to add `group`.
       *
       * Returns the UNION of everything already granted plus the new group, and
       * that is load-bearing rather than tidy.
       *
       * Google issues an access token carrying exactly the scopes the
       * authorisation request asked for. Re-authorising with only the Classroom
       * scopes therefore returns a token that can no longer read Calendar, and
       * Better Auth overwrites the stored token with it. The student sees
       * Calendar spontaneously disconnect the moment they connect Classroom.
       *
       * Asking for the union every time makes that impossible regardless of
       * whether include_granted_scopes is set on the authorisation URL.
       */
      .get('/connect-scopes/:group', auth, async (c) => {
        const group = c.req.param('group');
        if (!isConnectableGroup(group)) {
          return c.json({ error: 'Unknown scope group' }, 400);
        }

        const grant = await getGoogleGrant(ctx.db, c.get('userId'));
        const groups = [...new Set<ScopeGroup>([...grant.groups, group])];

        return c.json({ scopes: scopesFor(groups) });
      })
  );
}

/** Identity is granted at sign-in and is not separately connectable. */
function isConnectableGroup(value: string): value is 'calendar' | 'classroom' {
  return value in SCOPE_GROUPS && value !== 'identity';
}
