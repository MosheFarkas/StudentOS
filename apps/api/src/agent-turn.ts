import { eq } from 'drizzle-orm';
import { agentMessages, agents } from '@studentos/db';
import type { Message } from '@studentos/shared';
import { StudentOsError } from '@studentos/shared';
import { buildToolRegistry, runAgentTurn } from '@studentos/agent';
import type { AppContext } from './context.js';
import { BetterAuthGoogleTokenProvider, getGrantedGroups } from './google/connections.js';

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

  // Assembled per turn from what this student has actually connected.
  const granted = await getGrantedGroups(ctx.db, userId);

  const result = await runAgentTurn(
    {
      llm: ctx.llm,
      memory: ctx.memory,
      skills: ctx.skills,
      tools: buildToolRegistry(granted),
    },
    {
      userId,
      agentId: agent.id,
      purpose: agent.purpose,
      message: content,
      google: new BetterAuthGoogleTokenProvider(ctx.auth, userId, granted),
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
    throw new StudentOsError('internal_error', 'Failed to save messages.');
  }

  return { userMessage: toMessage(userMessage), assistantMessage: toMessage(assistantMessage) };
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
