import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import { Vault, buildGraph, readDocument, readUserDoc } from '@contexto/agent';
import { ContextoError } from '@contexto/shared';
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
       * The vault as a shape, for the picture in Settings.
       *
       * Scoped by student, not by agent. It was reached through an agent
       * before, which meant a student who deleted their agents lost sight of
       * their own school -- three and a half thousand notes, still on disk,
       * with nothing on the page to say so.
       *
       * The pages, not the notes. There are about ten of them and they are what
       * a student would recognise: their classes, their school, what they have
       * said. Drawing four thousand notes was a picture of how much there is
       * rather than of what any of it says, and cost four thousand rows over
       * the wire to be one.
       */
      .get('/graph', auth, async (c) => {
        const root = ctx.env?.VAULT_ROOT;
        if (!root) return c.json({ nodes: [], edges: [] });

        const { nodes, edges } = await buildGraph(new Vault(root, c.get('userId')));

        /*
         * Lean nodes, because there are thousands of them.
         *
         * Everything a drawing needs and nothing it does not: no descriptions
         * and no bodies. What a thing says is fetched when somebody clicks it,
         * which happens once, rather than for every node in the vault, which
         * happens on every load.
         */
        return c.json({
          nodes: nodes.map((node) => ({
            name: node.name,
            kind: node.kind,
            source: node.source,
            description: node.description,
            degree: node.degree,
            cluster: node.cluster,
          })),
          edges,
        });
      })

      /** One page, whole. What the picture opens when something is clicked. */
      .get('/doc/:name', auth, async (c) => {
        const root = ctx.env?.VAULT_ROOT;
        if (!root) throw new ContextoError('not_found', 'No vault for this student.');

        const document = await readDocument(new Vault(root, c.get('userId')), c.req.param('name'));
        if (!document) throw new ContextoError('not_found', 'No such page.');

        return c.json({
          document: {
            name: document.name,
            description: document.description,
            body: document.body,
          },
        });
      })

      /** One note, and everything that ever pointed at it. */
      .get('/note/:name', auth, async (c) => {
        const root = ctx.env?.VAULT_ROOT;
        if (!root) throw new ContextoError('not_found', 'No vault for this student.');

        const vault = new Vault(root, c.get('userId'));
        const name = c.req.param('name');
        const note = (await vault.read('entity', name)) ?? (await vault.read('episode', name));
        if (!note) throw new ContextoError('not_found', 'No such note.');

        /*
         * Mapped rather than returned whole. The stored note carries types
         * belonging to the vault, and handing them straight out makes this
         * route's shape depend on the agent package's internals.
         */
        return c.json({
          note: {
            name: note.name,
            kind: note.kind,
            source: note.source,
            description: note.description,
            body: note.body,
            occurred: note.occurred ?? null,
            actor: note.actor ?? null,
            event: (note.event as string | undefined) ?? null,
            sourceUrl: note.sourceUrl ?? null,
          },
          timeline: (await vault.backlinks(name)).map((entry) => ({
            name: entry.name,
            description: entry.description,
            source: entry.source,
            occurred: entry.occurred ?? null,
            actor: entry.actor ?? null,
            event: (entry.event as string | undefined) ?? null,
          })),
        });
      })

      /*
       * The document the agent reads before every reply.
       *
       * Behind the same session check as everything else here, so a student
       * can only ever fetch their own. Not rendered anywhere in the app yet:
       * it is new and generated, and something a model has written about a
       * person should be read by a person before it is shown to them.
       */
      .get('/about', auth, async (c) => {
        const root = ctx.env?.VAULT_ROOT;
        if (!root) return c.json({ about: null });
        return c.json({ about: await readUserDoc(new Vault(root, c.get('userId'))) });
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
