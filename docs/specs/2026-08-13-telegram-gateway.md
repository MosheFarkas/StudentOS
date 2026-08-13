# Telegram gateway

**Status:** approved, building
**Date:** 2026-08-13

Let students reach their agent from a phone, over Telegram, without the web app
open. Reactive only — the agent answers when messaged and never messages first.

## Why this shape

"24/7 agents" splits into two systems with very different costs. _Always
reachable_ reuses `runAgentTurn` unchanged and adds no inference cost — a turn
is a turn regardless of where it arrived from. _Always working_ (proactive)
means waking on a timer, and an agent polling every 15 minutes spends roughly
$2.42/student/month to conclude there is nothing to do, versus ~$0.05 for the
same behaviour driven by real events. Proactive is deferred, and when it lands
it should be event-driven (Google Calendar push notifications), not polled.

Telegram first because it is free and its bot API is trivial, which proves the
channel abstraction in a day. It is not where most US students are — that is
the point of building the abstraction rather than the integration. SMS is the
universal option and costs ~$2.37/student/month in Twilio fees at ten messages
a day, which would exceed the inference bill; that decision deserves real usage
data behind it.

## Architecture

New package `packages/channels` owning one interface:

```ts
interface Channel {
  id: ChannelId;
  verifyRequest(headers: Headers): boolean;
  parse(body: unknown): InboundMessage | null;
  send(channelUserId: string, text: string): Promise<void>;
  indicateTyping(channelUserId: string): Promise<void>;
}
```

Nothing outside the package learns which channel a message came from. Adding
Discord or SMS is a new implementation plus a route, with no change to the
agent layer.

## Data

- `channel_links` — `(userId, channel, channelUserId, agentId)`. Unique on
  `(channel, channelUserId)`: one Telegram account maps to exactly one agent.
- `channel_link_codes` — short-lived single-use codes carrying `userId` and the
  chosen `agentId`.

## Linking

Explicit and code-based. Settings shows a six-character code valid ten minutes;
the student sends `/link ABC123` to the bot.

Never infer identity from a phone number, username, or display name. The
webhook is a public unauthenticated endpoint, and anyone can message the bot —
identity must be proven by something only the account holder can see.

An unlinked sender gets link instructions for `/start` and `/link`, and is
**ignored otherwise**. That removes the reply-amplification vector without
needing rate-limit state: a stranger cannot make the bot emit unbounded
messages, and no agent ever runs for them.

## Request flow

1. `POST /api/channels/telegram/webhook`
2. Verify `X-Telegram-Bot-Api-Secret-Token` — without this anyone who finds the
   URL can forge updates.
3. Parse the update; ignore anything that is not a private text message.
4. Resolve `channel_links`. Unlinked → instructions (or silence) and stop.
5. **Return 200 immediately**, then run the turn asynchronously and push the
   reply via `sendMessage`.
6. Persist both messages to `agent_messages`.

Step 5 is not an optimisation. Telegram retries an update that is not
acknowledged within seconds, and an agent turn takes 2–10 — acknowledging late
produces duplicate replies, which is the classic Telegram bot failure.

The tradeoff: a crash between the 200 and the reply loses the message, because
fire-and-forget has no durability. Acceptable at this scale and noted in the
code; the fix is a job queue, not a bigger timeout.

## One transcript

Telegram turns write to `agent_messages` like web turns. A conversation started
on a phone continues on a laptop. Without this you have two agents that share a
name, which defeats the premise.

## Configuration

`TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, both optional. Unset means
the gateway is disabled: the webhook route 404s and Settings hides the option.
The product must run without it.

## Out of scope

Proactive messaging, group chats, voice notes, attachments, and every channel
other than Telegram.

## Deployment note

Webhooks need a public HTTPS URL, so this forces the droplet. It should be a
**fresh** droplet: `MASTER_ENCRYPTION_KEY` protects every student's API key, and
on a shared host any compromise in an unrelated project reaches it.
