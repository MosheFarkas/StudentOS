import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  CLASSROOM_COURSEWORK_WRITE_SCOPE,
  DRIVE_READONLY_SCOPE,
  ELECTIVE_SCOPES,
  SCOPE_GROUPS,
  listAccessibleFiles,
  missingOptionalScopes,
  parseGrantedScopes,
  scopesFor,
  type ScopeGroup,
} from '@contexto/agent';
import type { AppContext } from '../context.js';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from '../google/connections.js';
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
          // Drive being connected means "ready to be given files", not "can
          // read your Drive" -- access is per file. The UI has to say so.
          drive: grant.groups.includes('drive'),
          // Elective, so it needs reporting separately -- the classroom group
          // is "connected" without it.
          classroomWrite: parseGrantedScopes(grant.scope).has(CLASSROOM_COURSEWORK_WRITE_SCOPE),
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
      /*
       * Validated rather than read off c.req.query, so the flag appears in the
       * typed RPC client. Without it the web app cannot pass `elective` at all
       * and the broader grant is unreachable from the UI.
       */
      .get(
        '/connect-scopes/:group',
        auth,
        zValidator('query', z.object({ elective: z.enum(['true', 'false']).optional() })),
        async (c) => {
          const group = c.req.param('group');
          if (!isConnectableGroup(group)) {
            return c.json({ error: 'Unknown scope group' }, 400);
          }

          const grant = await getGoogleGrant(ctx.db, c.get('userId'));
          const groups = [...new Set<ScopeGroup>([...grant.groups, group])];

          /*
           * Elective scopes follow the same union rule as groups, for the same
           * reason. A student who granted full Drive access and then connects
           * Calendar must not have that quietly downgraded to per-file, so
           * everything already held is re-requested alongside anything new.
           */
          const held = parseGrantedScopes(grant.scope);
          const alreadyElective = ELECTIVE_SCOPES.filter((scope) => held.has(scope));
          const requested =
            c.req.valid('query').elective === 'true' ? (SCOPE_GROUPS[group].elective ?? []) : [];

          return c.json({
            scopes: scopesFor(groups, [...new Set([...alreadyElective, ...requested])]),
          });
        },
      )

      /**
       * The files the student has handed over.
       *
       * Drive itself is the record: under drive.file, files.list returns
       * exactly what was picked. Keeping our own table of picked ids would
       * add a second source of truth that drifts the moment a student
       * revokes access from their Google account.
       */
      .get('/drive/files', auth, async (c) => {
        const userId = c.get('userId');
        const grant = await getGoogleGrant(ctx.db, userId);

        if (!grant.groups.includes('drive')) {
          return c.json({ files: [], connected: false });
        }

        const provider = new BetterAuthGoogleTokenProvider(
          ctx.auth,
          userId,
          grant.groups,
          grant.scope,
        );
        const token = await provider.getAccessToken('drive');
        if (!token) {
          return c.json({
            files: [],
            connected: true,
            broadAccess: false,
            error: 'Reconnect Google in Settings.',
          });
        }

        const broadAccess = provider.hasScope(DRIVE_READONLY_SCOPE);
        const files = await listAccessibleFiles(token, { broadAccess });
        if ('unavailable' in files) {
          return c.json({ files: [], connected: true, broadAccess, error: files.reason });
        }

        /*
         * With full access this is the student's whole Drive, so it is a
         * preview rather than a list to manage -- Settings should not try to
         * render a thousand rows.
         */
        return c.json({ files: files.slice(0, 50), connected: true, broadAccess });
      })
  );
}

/** Identity is granted at sign-in and is not separately connectable. */
function isConnectableGroup(value: string): value is Exclude<ScopeGroup, 'identity'> {
  return value in SCOPE_GROUPS && value !== 'identity';
}
