import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq } from 'drizzle-orm';
import { agentMessages, agents } from '@studentos/db';
import { createAgentSchema, sendMessageSchema, StudentOsError } from '@studentos/shared';
import type { Agent, Message } from '@studentos/shared';
import { runAgentTurn, ToolRegistry } from '@studentos/agent';
import type { AppContext } from '../context.js';
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
      throw new StudentOsError('not_found', 'Agent not found.');
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

        if (!row) throw new StudentOsError('internal_error', 'Failed to create agent.');
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
        const { content } = c.req.valid('json');

        const [userMessage] = await ctx.db
          .insert(agentMessages)
          .values({ agentId: agent.id, role: 'user', content })
          .returning();

        const result = await runAgentTurn(
          {
            llm: ctx.llm,
            memory: ctx.memory,
            skills: ctx.skills,
            // Empty until OAuth lands: a student with no Google connection has
            // no tools, and registering ones that can only answer "not
            // connected" wastes context and invites dead-end tool calls.
            tools: new ToolRegistry(),
          },
          {
            userId,
            agentId: agent.id,
            purpose: agent.purpose,
            message: content,
            signal: c.req.raw.signal,
          },
        );

        const [assistantMessage] = await ctx.db
          .insert(agentMessages)
          .values({
            agentId: agent.id,
            role: 'assistant',
            content: result.reply,
            toolsUsed: result.toolsUsed,
          })
          .returning();

        // Surfaces the agent in the "recently used" ordering on the list screen.
        await ctx.db.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, agent.id));

        if (!userMessage || !assistantMessage) {
          throw new StudentOsError('internal_error', 'Failed to save messages.');
        }

        return c.json({
          userMessage: toMessage(userMessage),
          assistantMessage: toMessage(assistantMessage),
        });
      })
  );
}

function toAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessage(row: typeof agentMessages.$inferSelect): Message {
  return {
    id: row.id,
    agentId: row.agentId,
    role: row.role as Message['role'],
    content: row.content,
    toolsUsed: row.toolsUsed,
    createdAt: row.createdAt.toISOString(),
  };
}
