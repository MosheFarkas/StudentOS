import { Hono } from 'hono';
import { addCredentialSchema, type UsageStatus } from '@studentos/shared';
import { currentWindowEnd, currentWindowStart } from '@studentos/llm';
import type { AppContext } from '../context.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';

/**
 * Application routes.
 *
 * The return type is exported so the web app can build a fully typed client
 * with hono/client -- no hand-maintained API types, no codegen step.
 *
 * Agent conversation endpoints are deliberately absent: runAgentTurn is a
 * skeleton, and a route that calls it would be a half-built feature.
 */
export function createRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);

  return (
    new Hono<{ Variables: AuthVariables }>()
      .get('/health', (c) => c.json({ ok: true }))

      /** Which BYOK keys this student has stored. Never includes key material. */
      .get('/credentials', auth, async (c) => {
        const credentials = await ctx.vault.list(c.get('userId'));
        return c.json({ credentials });
      })

      .post('/credentials', auth, async (c) => {
        const body = addCredentialSchema.parse(await c.req.json());
        const credential = await ctx.vault.add({ userId: c.get('userId'), ...body });
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
