import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { agents, channelLinkCodes, channelLinks } from '@contexto/db';
import { parseCommand } from '@contexto/channels';
import { ContextoError } from '@contexto/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { runTurnForAgent } from '../agent-turn.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';

/** Excludes 0/O/1/I so a code read off a screen cannot be mistyped. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function createChannelRoutes(ctx: AppContext) {
  const auth = requireAuth(ctx);

  return (
    new Hono<{ Variables: AuthVariables }>()
      /** Which channels this student has linked, for Settings. */
      .get('/status', auth, async (c) => {
        const links = await ctx.db
          .select({ channel: channelLinks.channel, agentId: channelLinks.agentId })
          .from(channelLinks)
          .where(eq(channelLinks.userId, c.get('userId')));

        return c.json({
          telegramAvailable: ctx.telegram !== undefined,
          links,
        });
      })

      /**
       * Mint a one-time linking code.
       *
       * The code is the only thing proving the person messaging the bot owns
       * this account -- it is shown inside an authenticated session and nowhere
       * else. Short TTL and single use, because a linking code that outlives
       * the moment is a standing way into someone's agent.
       */
      .post(
        '/telegram/link-code',
        auth,
        zValidator('json', z.object({ agentId: z.uuid() })),
        async (c) => {
          if (!ctx.telegram) {
            throw new ContextoError('not_found', 'The Telegram gateway is not configured.');
          }

          const userId = c.get('userId');
          const { agentId } = c.req.valid('json');

          // Scoped by userId so a student cannot bind someone else's agent.
          const [agent] = await ctx.db
            .select()
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .limit(1);

          if (!agent) throw new ContextoError('not_found', 'Agent not found.');

          const code = generateCode();
          const expiresAt = new Date(Date.now() + CODE_TTL_MS);

          await ctx.db
            .insert(channelLinkCodes)
            .values({ code, userId, agentId, channel: 'telegram', expiresAt });

          return c.json({ code, expiresAt: expiresAt.toISOString() });
        },
      )

      .delete('/telegram/link', auth, async (c) => {
        await ctx.db
          .delete(channelLinks)
          .where(
            and(eq(channelLinks.userId, c.get('userId')), eq(channelLinks.channel, 'telegram')),
          );
        return c.body(null, 204);
      })

      /**
       * Telegram webhook. Public and unauthenticated by nature.
       *
       * Two rules hold this together:
       *
       *   1. The secret token is checked before anything else runs. Without it
       *      anyone who discovers this URL can forge messages.
       *   2. We answer 200 immediately and do the work afterwards. Telegram
       *      retries updates it has not seen acknowledged within seconds, and
       *      an agent turn takes 2-10 -- acknowledging late produces duplicate
       *      replies, which is the classic bot bug.
       */
      .post('/telegram/webhook', async (c) => {
        const telegram = ctx.telegram;
        if (!telegram) return c.body(null, 404);

        if (!telegram.verifyRequest(c.req.raw.headers)) {
          return c.json({ error: 'invalid signature' }, 401);
        }

        const message = telegram.parse(await c.req.json().catch(() => null));
        // 200 on unparseable input too -- a 4xx just makes Telegram retry
        // something we are never going to handle.
        if (!message) return c.json({ ok: true });

        // Deliberately NOT passing c.req.raw.signal into the async work: that
        // signal aborts once this response is sent, which would cancel every
        // turn the moment we acknowledge.
        void handleMessage(ctx, message).catch((error: unknown) => {
          console.error('[telegram] failed to handle message', error);
        });

        return c.json({ ok: true });
      })
  );
}

async function handleMessage(
  ctx: AppContext,
  message: { channelUserId: string; text: string },
): Promise<void> {
  const telegram = ctx.telegram;
  if (!telegram) return;

  const [link] = await ctx.db
    .select()
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, 'telegram'),
        eq(channelLinks.channelUserId, message.channelUserId),
      ),
    )
    .limit(1);

  const command = parseCommand(message.text);

  if (!link) {
    /*
     * Unlinked sender.
     *
     * Reply ONLY to the two commands that can lead somewhere, and stay silent
     * otherwise. That removes the reply-amplification vector without needing
     * rate-limit state: a stranger cannot make the bot emit unbounded messages,
     * and no agent -- and no inference spend -- is ever reachable by someone
     * who has not proven they own an account.
     */
    if (command === 'start') {
      await telegram.send(
        message.channelUserId,
        'Hi! Link this chat to your Contexto agent:\n\n' +
          '1. Open Contexto in your browser\n' +
          '2. Settings -> Connect Telegram\n' +
          '3. Send me: /link YOURCODE',
      );
      return;
    }

    if (command && typeof command === 'object') {
      await redeemCode(ctx, message.channelUserId, command.code);
    }
    return;
  }

  // Already linked -- /link again is a no-op worth acknowledging rather than
  // silently ignoring.
  if (command && typeof command === 'object') {
    await telegram.send(message.channelUserId, 'This chat is already linked to your agent.');
    return;
  }
  if (command === 'start') {
    await telegram.send(message.channelUserId, 'You are linked. Just send me a message.');
    return;
  }

  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, link.agentId)).limit(1);
  if (!agent) {
    await telegram.send(
      message.channelUserId,
      'That agent no longer exists. Re-link from Settings in Contexto.',
    );
    return;
  }

  await telegram.indicateTyping(message.channelUserId);

  try {
    const result = await runTurnForAgent(ctx, {
      userId: link.userId,
      agent,
      content: message.text,
    });
    await telegram.send(message.channelUserId, result.assistantMessage.content);
  } catch (error) {
    // Quota and missing-provider errors are the student's to act on, so pass
    // those through. Everything else stays generic -- upstream provider errors
    // can carry key material.
    const text =
      error instanceof ContextoError
        ? error.message
        : 'Something went wrong handling that. Try again in a moment.';
    if (!(error instanceof ContextoError)) {
      console.error('[telegram] turn failed', error);
    }
    await telegram.send(message.channelUserId, text);
  }

  await ctx.db
    .update(channelLinks)
    .set({ lastMessageAt: new Date() })
    .where(eq(channelLinks.id, link.id));
}

async function redeemCode(ctx: AppContext, channelUserId: string, code: string): Promise<void> {
  const telegram = ctx.telegram;
  if (!telegram) return;

  const [row] = await ctx.db
    .select()
    .from(channelLinkCodes)
    .where(
      and(
        eq(channelLinkCodes.code, code),
        eq(channelLinkCodes.channel, 'telegram'),
        isNull(channelLinkCodes.usedAt),
        gt(channelLinkCodes.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row) {
    await telegram.send(
      channelUserId,
      'That code is not valid or has expired. Generate a new one in Settings.',
    );
    return;
  }

  // Mark used before creating the link. If the insert fails the code is spent
  // rather than replayable, which is the safer direction to fail in.
  await ctx.db
    .update(channelLinkCodes)
    .set({ usedAt: new Date() })
    .where(eq(channelLinkCodes.code, row.code));

  try {
    await ctx.db.insert(channelLinks).values({
      userId: row.userId,
      channel: 'telegram',
      channelUserId,
      agentId: row.agentId,
    });
  } catch {
    // Unique on (channel, channel_user_id): this Telegram account is already
    // bound to an account. Never silently re-point it at a different student.
    await telegram.send(
      channelUserId,
      'This Telegram account is already linked. Unlink it in Settings first.',
    );
    return;
  }

  await telegram.send(channelUserId, 'Linked. Send me anything and your agent will answer.');
}
