import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { user } from '@contexto/db';
import { addCredentialSchema, ContextoError, type UsageStatus } from '@contexto/shared';
import { currentWindowEnd, currentWindowStart } from '@contexto/llm';
import type { AppContext } from '../context.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { createAgentRoutes } from './agents.js';
import { createChannelRoutes } from './channels.js';
import { createGoogleRoutes } from './google.js';

/**
 * Application routes.
 *
 * The return type is exported so the web app can build a fully typed client
 * with hono/client -- no hand-maintained API types, no codegen step.
 */
export function createRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);

  return (
    new Hono<{ Variables: AuthVariables }>()
      .get('/health', (c) => c.json({ ok: true }))

      /**
       * Record the student's timezone.
       *
       * Sent by the browser, which is the only thing that reliably knows it.
       * Validated against the runtime's own timezone database rather than a
       * regex -- a bogus zone would otherwise be stored and then throw on
       * every turn when the prompt tries to format a time in it.
       */
      .put(
        '/me/timezone',
        auth,
        zValidator('json', z.object({ timezone: z.string().min(1).max(64) })),
        async (c) => {
          const { timezone } = c.req.valid('json');

          try {
            new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
          } catch {
            throw new ContextoError('validation_failed', 'Unknown timezone.');
          }

          await ctx.db
            .update(user)
            .set({ timezone })
            .where(eq(user.id, c.get('userId')));

          return c.body(null, 204);
        },
      )

      .route('/agents', createAgentRoutes(ctx))
      .route('/google', createGoogleRoutes(ctx))
      .route('/channels', createChannelRoutes(ctx))

      /** Which BYOK keys this student has stored. Never includes key material. */
      .get('/credentials', auth, async (c) => {
        const credentials = await ctx.vault.list(c.get('userId'));
        return c.json({ credentials });
      })

      .post('/credentials', auth, zValidator('json', addCredentialSchema), async (c) => {
        const credential = await ctx.vault.add({
          userId: c.get('userId'),
          ...c.req.valid('json'),
        });
        return c.json({ credential }, 201);
      })

      .delete('/credentials/:id', auth, async (c) => {
        await ctx.vault.remove(c.get('userId'), c.req.param('id'));
        return c.body(null, 204);
      })

      /**
       * Where the student currently stands: own key or our tier, and how much of
       * their allowance is left. Drives the "you're running low" nudge toward
       * adding their own key.
       */
      .get('/usage', auth, async (c) => {
        const userId = c.get('userId');
        const credentials = await ctx.vault.list(userId);

        if (credentials.length > 0) {
          const status: UsageStatus = {
            activeProvider: credentials[0]!.provider,
            quota: null,
          };
          return c.json(status);
        }

        const status: UsageStatus = {
          activeProvider: 'platform',
          quota: {
            windowStart: currentWindowStart().toISOString(),
            windowEnd: currentWindowEnd().toISOString(),
            tokensUsed: await ctx.quota.tokensUsedThisWindow(userId),
            tokenLimit: ctx.quota.limit,
          },
        };
        return c.json(status);
      })
  );
}

export type AppRoutes = ReturnType<typeof createRoutes>;
