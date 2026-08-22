import { eq } from 'drizzle-orm';
import { agentMessages, agents, user } from '@contexto/db';
import type { Message } from '@contexto/shared';
import { ContextoError } from '@contexto/shared';
import { buildToolRegistry, runAgentTurn } from '@contexto/agent';
import type { AppContext } from './context.js';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from './google/connections.js';
import { DbPortalSnapshots } from './portal-snapshots.js';
import { beginTurn, endTurn, setActivity } from './turns-in-flight.js';

/**
 * Run one agent turn and persist both sides of it.
 *
 * Shared by the web route and the messaging gateway so a Telegram turn and a
 * browser turn are genuinely the same operation -- same tools, same quota, same
 * transcript. If these ever diverge you have two agents wearing one name, which
 * is exactly what the product promises not to be.
 */
export async function runTurnForAgent(
  ctx: AppContext,
  params: {
    userId: string;
    agent: typeof agents.$inferSelect;
    content: string;
    signal?: AbortSignal;
  },
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  const { userId, agent, content, signal } = params;

  const [userMessage] = await ctx.db
    .insert(agentMessages)
    .values({ agentId: agent.id, role: 'user', content })
    .returning();

  /*
   * From here until the reply is written, this conversation is busy.
   *
   * The question is already saved and the answer does not exist yet, which is
   * exactly the window in which a page loaded from scratch can tell neither
   * that it is coming nor that it was dropped. Marked after the insert so the
   * two are true together: there is a question outstanding, and something is
   * working on it.
   */
  beginTurn(agent.id);
  try {
    // Assembled per turn from what this student has actually connected.
    const [grant, [profile]] = await Promise.all([
      getGoogleGrant(ctx.db, userId),
      ctx.db.select({ timezone: user.timezone }).from(user).where(eq(user.id, userId)).limit(1),
    ]);

    const result = await runAgentTurn(
      {
        llm: ctx.llm,
        memory: ctx.memory,
        skills: ctx.skills,
        tools: buildToolRegistry(grant.scope, grant.disabled),
      },
      {
        userId,
        agentId: agent.id,
        purpose: agent.purpose,
        message: content,
        ...(profile?.timezone ? { timezone: profile.timezone } : {}),
        google: new BetterAuthGoogleTokenProvider(ctx.auth, userId, grant.groups, grant.scope),
        ...(ctx.transcriber ? { transcriber: ctx.transcriber } : {}),
        youtube: ctx.youtube,
        youtubeTranscripts: ctx.youtubeTranscripts,
        ...(ctx.residential ? { residentialFetch: ctx.residential.fetch } : {}),
        portals: new DbPortalSnapshots(ctx.db),
        /*
         * Every step the turn takes, handed to the registry the poll reads.
         * This is the whole of what makes the line under a question say what
         * the agent is doing rather than only that it is doing something.
         */
        onActivity: (activity) => setActivity(agent.id, activity),
        ...(signal ? { signal } : {}),
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
      throw new ContextoError('internal_error', 'Failed to save messages.');
    }

    return { userMessage: toMessage(userMessage), assistantMessage: toMessage(assistantMessage) };
  } finally {
    // In a finally: a turn that throws has stopped just as surely as one that
    // succeeded, and leaving it marked busy would spin a thinking indicator
    // for a conversation nothing is working on.
    endTurn(agent.id);
  }
}

export function toMessage(row: typeof agentMessages.$inferSelect): Message {
  return {
    id: row.id,
    agentId: row.agentId,
    role: row.role as Message['role'],
    content: row.content,
    toolsUsed: row.toolsUsed,
    createdAt: row.createdAt.toISOString(),
  };
}
