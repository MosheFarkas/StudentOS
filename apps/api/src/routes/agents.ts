import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq } from 'drizzle-orm';
import { agentMessages, agents } from '@contexto/db';
import {
  createAgentSchema,
  sendMessageSchema,
  updateProfileSchema,
  ContextoError,
} from '@contexto/shared';
import type { Agent } from '@contexto/shared';
import type { AppContext } from '../context.js';
import { runTurnForAgent, toMessage } from '../agent-turn.js';
import { turnActivity, turnRunning } from '../turns-in-flight.js';
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

      /*
       * Correcting what the agent thinks it knows.
       *
       * Deliberately a full replace rather than an append: the student is
       * editing a document, not filing a correction, and the writer will
       * rewrite it from here anyway. Clearing it to empty is a first-class
       * outcome -- "forget what you think you know about me" is the whole
       * reason a person needs to see this at all.
       *
       * The watermark moves with it, so the next pass builds on what they
       * wrote rather than re-deriving what they just deleted.
       */
      .patch('/:id/profile', auth, zValidator('json', updateProfileSchema), async (c) => {
        await ownedAgent(c.get('userId'), c.req.param('id'));
        const [row] = await ctx.db
          .update(agents)
          .set({ profile: c.req.valid('json').profile.trim(), profileUpdatedAt: new Date() })
          .where(eq(agents.id, c.req.param('id')))
          .returning();

        if (!row) throw new ContextoError('internal_error', 'Failed to update the profile.');
        return c.json({ agent: toAgent(row) });
      })

      .delete('/:id', auth, async (c) => {
        await ownedAgent(c.get('userId'), c.req.param('id'));
        // Messages, memories, and skills cascade -- see the FKs in packages/db.
        await ctx.db.delete(agents).where(eq(agents.id, c.req.param('id')));
        return c.body(null, 204);
      })

      .get('/:id/messages', auth, async (c) => {
        const agent = await ownedAgent(c.get('userId'), c.req.param('id'));
        const rows = await ctx.db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.agentId, agent.id))
          .orderBy(asc(agentMessages.createdAt));

        /*
         * Whether something is working on this conversation right now.
         *
         * A turn outlives the request that started it, so a page loaded after
         * the student closed or refreshed has no local memory of asking. The
         * answer arrives minutes later out of nowhere unless the conversation
         * itself can say it is still thinking.
         */
        return c.json({
          messages: rows.map(toMessage),
          pending: turnRunning(agent.id),
          /*
           * And what it is on, when something is. Absent rather than null on
           * a quiet conversation: there is no step, and a shape saying there
           * is one that happens to be empty invites the client to render it.
           */
          activity: turnActivity(agent.id),
        });
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

function toAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    profile: row.profile,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
