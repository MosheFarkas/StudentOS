import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  CLASSROOM_COURSEWORK_WRITE_SCOPE,
  DRIVE_READONLY_SCOPE,
  GMAIL_MODIFY_SCOPE,
  ELECTIVE_SCOPES,
  SCOPE_GROUPS,
  listAccessibleFiles,
  missingOptionalScopes,
  parseGrantedScopes,
  scopesFor,
  type ScopeGroup,
} from '@contexto/agent';
import { and, eq, inArray } from 'drizzle-orm';
import { disabledIntegrations } from '@contexto/db';
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
          disabled: grant.disabled,
          calendar: grant.groups.includes('calendar'),
          classroom: grant.groups.includes('classroom'),
          // Drive being connected means "ready to be given files", not "can
          // read your Drive" -- access is per file. The UI has to say so.
          drive: grant.groups.includes('drive'),
          gmail: grant.groups.includes('gmail'),
          // Elective, so it needs reporting separately -- the classroom group
          // is "connected" without it.
          classroomWrite: parseGrantedScopes(grant.scope).has(CLASSROOM_COURSEWORK_WRITE_SCOPE),
          // Sending is elective, so the classroom group reads as connected
          // without it -- the UI has to report it separately.
          gmailWrite: parseGrantedScopes(grant.scope).has(GMAIL_MODIFY_SCOPE),
          missing: {
            calendar: missingOptionalScopes('calendar', grant.scope),
            classroom: missingOptionalScopes('classroom', grant.scope),
            gmail: missingOptionalScopes('gmail', grant.scope),
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
          const grant = await getGoogleGrant(ctx.db, c.get('userId'));

          /*
           * 'all' is the one-tap path: everything, including the write half
           * of each integration. A student choosing it has said yes once to
           * the whole product rather than four times to pieces of it.
           */
          if (group === 'all') {
            const every = Object.keys(SCOPE_GROUPS) as ScopeGroup[];
            return c.json({ scopes: scopesFor(every, ELECTIVE_SCOPES) });
          }

          if (!isConnectableGroup(group)) {
            return c.json({ error: 'Unknown scope group' }, 400);
          }

          const groups = [...new Set<ScopeGroup>([...grant.groups, group])];

          /*
           * Elective scopes follow the same union rule as groups, for the same
           * reason. A student who granted full Drive access and then connects
           * Calendar must not have that quietly downgraded to per-file, so
           * everything already held is re-requested alongside anything new.
           */
          const held = parseGrantedScopes(grant.scope);
          const alreadyElective = ELECTIVE_SCOPES.filter((scope) => held.has(scope));
          /*
           * The write half comes WITH the integration rather than as a second
           * trip through consent. The student still controls it -- the switch
           * in Settings turns it off, and the tools disappear when it is off
           * -- but they are not asked twice for one decision.
           */
          const requested =
            c.req.valid('query').elective === 'false' ? [] : (SCOPE_GROUPS[group].elective ?? []);

          return c.json({
            scopes: scopesFor(groups, [...new Set([...alreadyElective, ...requested])]),
          });
        },
      )

      /**
       * Turn an integration on or off without touching the OAuth grant.
       *
       * A switch, not a revocation: turning Gmail off stops the agent using
       * it immediately, and turning it back on does not mean another trip
       * through Google's consent screen. Revoking properly is still available
       * to the student at Google itself, and is the heavier action.
       */
      .put(
        '/integrations/:group',
        auth,
        zValidator('json', z.object({ enabled: z.boolean() })),
        async (c) => {
          const key = c.req.param('group');
          const [name, part] = key.split(':');
          if (!name || !isConnectableGroup(name) || (part && part !== 'write')) {
            return c.json({ error: 'Unknown integration' }, 400);
          }
          const userId = c.get('userId');
          const { enabled } = c.req.valid('json');

          /*
           * A parent carries its child. Switching Gmail off must take sending
           * with it -- leaving "can send email" on under a disabled Gmail
           * would be a setting that reads as active and is not. Switching the
           * parent back on restores the child too, which is what a student
           * means by turning something back on.
           *
           * The child on its own changes only itself, so sending can be off
           * while reading stays on.
           */
          const affected = part === 'write' ? [key] : [name, `${name}:write`];

          if (enabled) {
            await ctx.db
              .delete(disabledIntegrations)
              .where(
                and(
                  eq(disabledIntegrations.userId, userId),
                  inArray(disabledIntegrations.integration, affected),
                ),
              );
          } else {
            await ctx.db
              .insert(disabledIntegrations)
              .values(affected.map((integration) => ({ userId, integration })))
              .onConflictDoNothing();
          }

          return c.json({ integration: key, enabled, affected });
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
