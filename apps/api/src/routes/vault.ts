import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import { Vault } from '@contexto/agent';
import type { AppContext } from '../context.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { getGoogleGrant } from '../google/connections.js';
import { buildProgress, buildRunning, startBuild, vaultReadiness } from '../vault-build.js';
import { refreshVaultFor } from '../vault-refresh.js';

/**
 * The student's vault, as something they own rather than something an agent has.
 *
 * Scoped by student and not by agent, unlike the read routes under /agents.
 * A vault outlives the agents that read it -- the account this was built
 * against has three and a half thousand notes and no agents at all -- so a
 * page that can only reach it through one would show that student nothing.
 */
export function createVaultRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);

  return (
    new Hono<{ Variables: AuthVariables }>()
      .get('/', auth, async (c) => {
        const userId = c.get('userId');
        const [owner] = await ctx.db.select().from(user).where(eq(user.id, userId)).limit(1);
        const grant = await getGoogleGrant(ctx.db, userId);
        const readiness = vaultReadiness(
          (grant.scope ?? '').split(/[\s,]+/).filter(Boolean),
          owner?.email ?? '',
        );

        const root = ctx.env?.VAULT_ROOT;
        if (!root) {
          return c.json({
            ...readiness,
            entities: 0,
            episodes: 0,
            building: false,
            progress: null,
          });
        }

        /*
         * Counted, not listed. This is polled every few seconds while a build
         * runs, and listing a vault reads and parses every note in it -- which
         * on three thousand notes would be the polling competing with the
         * build it reports on.
         */
        const progress = buildProgress(userId);
        const vault = new Vault(root, userId);
        const [entities, episodes] = await Promise.all([
          vault.count('entity'),
          vault.count('episode'),
        ]);

        return c.json({
          ...readiness,
          entities,
          episodes,
          building: buildRunning(userId),
          /*
           * Mapped rather than returned whole, and phase widened to a string.
           *
           * Handing the stored shape straight out makes this route's inferred
           * type depend on a union declared inside the API package, which the
           * web app then cannot name -- the compiler says so rather than
           * anyone discovering it later. Null rather than absent, because the
           * page draws a bar from this and an optional field that is
           * sometimes missing is a shape to guess at.
           */
          progress: progress
            ? {
                phase: progress.phase as string,
                done: progress.done,
                total: progress.total,
                startedAt: progress.startedAt,
              }
            : null,
        });
      })

      /*
       * Build it now, rather than when the timer next comes round.
       *
       * The periodic refresh runs every six hours and deliberately not on boot,
       * so a student who has just connected their school waits most of a day
       * with nothing saying anything is coming. This is that same work, started
       * because somebody asked.
       */
      .post('/build', auth, async (c) => {
        const userId = c.get('userId');
        const [owner] = await ctx.db.select().from(user).where(eq(user.id, userId)).limit(1);
        const grant = await getGoogleGrant(ctx.db, userId);
        const readiness = vaultReadiness(
          (grant.scope ?? '').split(/[\s,]+/).filter(Boolean),
          owner?.email ?? '',
        );

        if (!readiness.ready) {
          return c.json({ started: false, reason: 'not-connected', ...readiness }, 400);
        }
        if (!ctx.env?.VAULT_ROOT) {
          return c.json({ started: false, reason: 'no-vaults-here' }, 400);
        }

        // Returns immediately. The work is minutes long and the student should
        // be watching a count climb, not a spinner on a request.
        const started = startBuild(userId, () => refreshVaultFor(ctx, userId));
        return c.json(
          { started, ...(started ? {} : { reason: 'already-building' }) },
          started ? 202 : 409,
        );
      })
  );
}
