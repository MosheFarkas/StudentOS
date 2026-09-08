import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { user } from '@contexto/db';
import type { AppContext } from '../context.js';
import { liveBells, type Bells } from '../vault-live.js';
import { syncStateByChannel } from '../vault-sync-state.js';

/**
 * Where Google rings the bell.
 *
 * No session: these are called by Pub/Sub and by Drive. Each carries a
 * secret instead -- the Pub/Sub push URL has one in its query string, and a
 * Drive channel echoes the token it was created with. A forged call can at
 * most trigger one extra sync of a student's own data with their own token.
 *
 * Answer fast and answer 2xx: Pub/Sub retries anything else, and the work
 * belongs to the queue, not to the request.
 */

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHookRoutes(ctx: AppContext, bells: Pick<Bells, 'ring'> = liveBells) {
  return (
    new Hono()
      /** Pub/Sub push: `{ message: { data: base64 JSON { emailAddress, historyId } } }`. */
      .post('/gmail', async (c) => {
        const secret = ctx.env.VAULT_HOOK_SECRET;
        if (!secret || !sameSecret(c.req.query('token') ?? '', secret)) return c.body(null, 401);

        const body = (await c.req.json().catch(() => null)) as {
          message?: { data?: string };
        } | null;
        const data = body?.message?.data;
        if (!data) return c.body(null, 204);

        let mailbox: string | null;
        try {
          const parsed = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as {
            emailAddress?: unknown;
          };
          mailbox =
            typeof parsed.emailAddress === 'string' ? parsed.emailAddress.toLowerCase() : null;
        } catch {
          return c.body(null, 204);
        }
        if (!mailbox) return c.body(null, 204);

        const [row] = await ctx.db
          .select({ id: user.id })
          .from(user)
          .where(sql`lower(${user.email}) = ${mailbox}`)
          .limit(1);
        if (row) bells.ring(row.id, 'gmail');
        return c.body(null, 204);
      })

      /** Drive channel: everything is in the headers, the body is empty. */
      .post('/drive', async (c) => {
        const channelId = c.req.header('x-goog-channel-id');
        const token = c.req.header('x-goog-channel-token');
        if (!channelId || !token) return c.body(null, 401);

        const state = await syncStateByChannel(ctx.db, channelId);
        if (!state?.driveChannelSecret || !sameSecret(token, state.driveChannelSecret)) {
          return c.body(null, 401);
        }

        // 'sync' is Drive saying the channel exists. Nothing changed.
        if (c.req.header('x-goog-resource-state') !== 'sync') bells.ring(state.userId, 'drive');
        return c.body(null, 200);
      })
  );
}
