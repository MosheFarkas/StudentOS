/**
 * The seam between "a student sent a message" and "which app they sent it from".
 *
 * Nothing outside this package should learn which channel a message arrived on.
 * Adding Discord or SMS later means writing one more implementation of this
 * interface -- the agent layer, the transcript, and the quota system stay
 * untouched.
 */

export type ChannelId = 'telegram' | 'discord' | 'sms' | 'whatsapp';

export interface InboundMessage {
  /**
   * Stable identifier for this sender WITHIN the channel, and the address we
   * reply to. For Telegram this is the chat id, not the user id -- they are the
   * same for private chats, but only the chat id is a valid send target.
   */
  channelUserId: string;
  text: string;
  /** Provider's own id for this update, for logging and deduplication. */
  externalId: string;
}

export interface Channel {
  readonly id: ChannelId;

  /**
   * Reject forged requests before doing any work.
   *
   * The webhook is a public URL with no authentication of its own. Anyone who
   * discovers it can post whatever they like unless this check is real.
   */
  verifyRequest(headers: Headers): boolean;

  /** Returns null for anything that is not a text message we handle. */
  parse(body: unknown): InboundMessage | null;

  send(channelUserId: string, text: string): Promise<void>;

  /**
   * Best-effort "typing" hint. Agent turns take seconds; without a signal the
   * chat looks broken. Failures here must never fail the turn.
   */
  indicateTyping(channelUserId: string): Promise<void>;
}

/** A `/link ABC123` message, parsed. */
export interface LinkCommand {
  code: string;
}

/**
 * Recognise the commands an unlinked sender is allowed to use.
 *
 * Everything else from an unlinked sender is ignored -- see the note in
 * the gateway route about reply amplification.
 */
export function parseCommand(text: string): 'start' | LinkCommand | null {
  const trimmed = text.trim();

  if (/^\/start\b/i.test(trimmed)) return 'start';

  const link = /^\/link\s+([A-Za-z0-9]{4,12})\b/.exec(trimmed);
  if (link?.[1]) return { code: link[1].toUpperCase() };

  return null;
}
