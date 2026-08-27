import { eq } from 'drizzle-orm';
import { agentMessages, agents, user } from '@contexto/db';
import type { Message } from '@contexto/shared';
import { ContextoError } from '@contexto/shared';
import {
  Vault,
  buildToolRegistry,
  listDocuments,
  readUserDoc,
  runAgentTurn,
} from '@contexto/agent';
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
/**
 * The student's vault, if this deployment has vaults and they have one.
 *
 * Entities OR pages. Notes are the usual reason a vault is worth handing to a
 * turn, but they are not the only one: what a student has told us across their
 * conversations is kept as a page in here now, and it is written for anyone who
 * talks to their agent whether or not they have ever connected a school.
 *
 * Gating on notes alone regressed exactly that. The document it replaced was a
 * column on the agent row and was read on every turn regardless; this one sat
 * on disk being written and never read for anybody with nothing imported.
 */
export async function vaultFor(
  root: string | undefined,
  ownerId: string,
): Promise<Vault | undefined> {
  if (!root) return undefined;
  const vault = new Vault(root, ownerId);
  if (await vault.has()) return vault;
  return (await listDocuments(vault)).length > 0 ? vault : undefined;
}

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
    const [grant, [profile], vault] = await Promise.all([
      getGoogleGrant(ctx.db, userId),
      ctx.db.select({ timezone: user.timezone }).from(user).where(eq(user.id, userId)).limit(1),
      /*
       * Only handed over when there is something in it.
       *
       * Its presence decides whether vault_search can find anything and
       * whether the reading rules go onto the prompt, so an agent whose
       * student has imported nothing carries neither -- and behaves exactly as
       * it did before vaults existed.
       */
      // Optional chaining, not laziness: this is the path a student is waiting
      // on, and a context assembled without env should degrade to no vault
      // rather than take the whole turn down.
      vaultFor(ctx.env?.VAULT_ROOT, userId),
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
        // What the summarisation job has learned about them, if anything yet.
        /*
         * Their school, in a paragraph, written when the vault was last built.
         *
         * Read from disk on every turn rather than cached in memory: it
         * changes only when a vault is rebuilt, a read is one small file, and
         * a stale copy in a long-lived process would describe last term.
         */
        ...(vault ? { about: (await readUserDoc(vault)) ?? undefined } : {}),
        ...(vault ? { vault } : {}),
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
