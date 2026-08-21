import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { agentMessages, agents } from '@contexto/db';
import { createAgentSchema, sendMessageSchema, ContextoError } from '@contexto/shared';
import type { Agent } from '@contexto/shared';
import type { AppContext } from '../context.js';
import { runTurnForAgent, toMessage } from '../agent-turn.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';

export function createAgentRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);

  /**
   * Load an agent, or throw if it does not belong to the caller.
   *
   * Every handler goes through this. Scoping the query by userId rather than
   * fetching then comparing means a mistake produces "not found" rather than
   * someone else's agent -- and it is one query either way.
   */
  async function ownedAgent(userId: string, agentId: string) {
    const [row] = await ctx.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .limit(1);

    if (!row) {
      throw new ContextoError('not_found', 'Agent not found.');
    }
    return row;
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .get('/', auth, async (c) => {
        const rows = await ctx.db
          .select()
          .from(agents)
          .where(eq(agents.userId, c.get('userId')))
          .orderBy(desc(agents.updatedAt));

        return c.json({ agents: rows.map(toAgent) });
      })

      // zValidator, not a parse() inside the handler: it validates at the route
      // boundary AND lets hono/client infer the request body type, so a schema
      // change is a compile error in the web app rather than a runtime 400.
      .post('/', auth, zValidator('json', createAgentSchema), async (c) => {
        const body = c.req.valid('json');
        const [row] = await ctx.db
          .insert(agents)
          .values({ userId: c.get('userId'), ...body })
          .returning();

        if (!row) throw new ContextoError('internal_error', 'Failed to create agent.');
        return c.json({ agent: toAgent(row) }, 201);
      })

      .get('/:id', auth, async (c) => {
        const row = await ownedAgent(c.get('userId'), c.req.param('id'));
        return c.json({ agent: toAgent(row) });
      })

      .delete('/:id', auth, async (c) => {
        await ownedAgent(c.get('userId'), c.req.param('id'));
        // Messages, memories, and skills cascade -- see the FKs in packages/db.
        await ctx.db.delete(agents).where(eq(agents.id, c.req.param('id')));
        return c.body(null, 204);
      })

      /*
       * The live view of the browser, for a website that has no browser of
       * its own to show.
       *
       * Held open until the page repaints. A finished page emits nothing at
       * all, so a timeout is the ordinary ending rather than a fault, and 204
       * says exactly that: nothing newer, ask again.
       */
      .get(
        '/:id/session/frame',
        auth,
        // Declared rather than read loose, so the web client's types carry it
        // and a rename here is a compile error there.
        zValidator(
          'query',
          z.object({ since: z.coerce.number().optional(), wait: z.coerce.number().optional() }),
        ),
        async (c) => {
          const agent = await ownedAgent(c.get('userId'), c.req.param('id'));
          const since = Number(c.req.valid('query').since ?? 0);
          /*
           * The caller may ask to be answered sooner, never later. A first poll
           * that wants to paint something immediately should not have to sit
           * through the full hold, and a caller cannot use this to pin a
           * request open beyond what the server was willing to give.
           */
          const asked = Number(c.req.valid('query').wait ?? FRAME_WAIT_MS);
          const wait = Number.isFinite(asked)
            ? Math.min(Math.max(asked, 0), FRAME_WAIT_MS)
            : FRAME_WAIT_MS;

          const frame = await ctx.live.waitForFrame(
            agent.id,
            Number.isFinite(since) ? since : 0,
            wait,
          );
          if (!frame) return c.body(null, 204);
          return c.json(frame);
        },
      )

      /*
       * A click or a keystroke, on its way to the real browser.
       *
       * This drives a browser signed into the student's school portal, which
       * is why it is scoped to their own agent and nothing else: the session
       * that can send these is the same session that could already read
       * everything behind that login.
       */
      .post(
        '/:id/session/input',
        auth,
        zValidator('json', z.object({ events: z.array(inputEventSchema).max(32) })),
        async (c) => {
          const agent = await ownedAgent(c.get('userId'), c.req.param('id'));
          ctx.live.pushInput(agent.id, c.req.valid('json').events);
          return c.body(null, 204);
        },
      )

      .get('/:id/messages', auth, async (c) => {
        const agent = await ownedAgent(c.get('userId'), c.req.param('id'));
        const rows = await ctx.db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.agentId, agent.id))
          .orderBy(asc(agentMessages.createdAt));

        return c.json({ messages: rows.map(toMessage) });
      })

      /**
       * Send a message and run a turn.
       *
       * Not streamed. A turn that calls tools can take a while, and the honest
       * first version returns a complete answer rather than a half-wired stream
       * -- the OpenAI adapter's streaming path still cannot reassemble
       * fragmented tool-call deltas. Streaming is the next thing worth doing
       * here, and it is a provider-layer fix, not a route-layer one.
       */
      .post('/:id/messages', auth, zValidator('json', sendMessageSchema), async (c) => {
        const userId = c.get('userId');
        const agent = await ownedAgent(userId, c.req.param('id'));

        /*
         * Deliberately not tied to the request.
         *
         * Passing c.req.raw.signal meant a student who closed the window or
         * reloaded mid-turn killed the work: the user's message is written
         * before the model runs, the reply only after, so aborting left the
         * question saved with no answer and nothing to say one was coming.
         * The turn now finishes and the reply is stored, and they find it when
         * they come back.
         *
         * Shared with the messaging gateway -- see src/agent-turn.ts.
         */
        const result = await runTurnForAgent(ctx, {
          userId,
          agent,
          content: c.req.valid('json').content,
        });

        return c.json(result);
      })
  );
}

/**
 * How long the website waits on a repaint before being told to ask again.
 *
 * Comfortably inside any proxy read timeout, and long enough that a page
 * sitting still costs three requests a minute rather than three a second.
 */
const FRAME_WAIT_MS = 20 * 1000;

/*
 * What the website may send back into the real browser.
 *
 * Enumerated rather than passed through. These are replayed by a debugger
 * attached to a browser holding a school login, so the set of things sayable
 * over this channel is worth stating exactly: pointer, wheel, keys. Nothing
 * that navigates, evaluates, or reaches the protocol underneath.
 */
const inputEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    type: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved']),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(['left', 'none']),
    clickCount: z.number().int().min(0).max(3),
  }),
  z.object({
    kind: z.literal('wheel'),
    x: z.number().finite(),
    y: z.number().finite(),
    deltaX: z.number().finite(),
    deltaY: z.number().finite(),
  }),
  z.object({
    kind: z.literal('key'),
    type: z.enum(['keyDown', 'keyUp', 'char']),
    key: z.string().max(32),
    code: z.string().max(32),
    text: z.string().max(8).optional(),
  }),
]);

function toAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
