import { createHash, timingSafeEqual } from 'node:crypto';
import type { Channel, InboundMessage } from '../types.js';

const API_BASE = 'https://api.telegram.org';

export interface TelegramOptions {
  botToken: string;
  /**
   * Shared secret registered with setWebhook. Telegram echoes it back on every
   * request in X-Telegram-Bot-Api-Secret-Token.
   */
  webhookSecret: string;
}

/**
 * Telegram Bot API channel.
 *
 * Deliberately handles only private text messages. Group chats, edited
 * messages, captions, and attachments all parse to null rather than being
 * half-supported -- a group chat in particular would leak one student's agent
 * to everyone in the room.
 */
export class TelegramChannel implements Channel {
  readonly id = 'telegram' as const;

  constructor(private readonly options: TelegramOptions) {}

  /**
   * Whether this really came from Telegram.
   *
   * The only route on the server the public internet can reach without
   * credentials, and the secret is the whole of what stands in front of it --
   * anything that gets past speaks to a student's agent as that student.
   *
   * Compared in constant time. `===` on strings returns as soon as two bytes
   * differ, which leaks how much of a guess was right; over a network that is
   * a hard attack to land, but the defence costs one line and the thing being
   * defended is every account on the box. Both sides are hashed first so the
   * comparison is over a fixed length and the secret's own length does not
   * leak either.
   */
  verifyRequest(headers: Headers): boolean {
    const provided = headers.get('x-telegram-bot-api-secret-token');
    if (typeof provided !== 'string') return false;
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(provided), digest(this.options.webhookSecret));
  }

  parse(body: unknown): InboundMessage | null {
    if (typeof body !== 'object' || body === null) return null;
    const update = body as TelegramUpdate;

    const message = update.message;
    if (!message?.text) return null;

    // Private chats only. A bot added to a group would otherwise answer with
    // one member's agent in front of everyone else.
    if (message.chat?.type !== 'private') return null;
    if (message.from?.is_bot) return null;

    const chatId = message.chat.id;
    if (typeof chatId !== 'number') return null;

    return {
      channelUserId: String(chatId),
      text: message.text,
      externalId: String(update.update_id),
    };
  }

  async send(channelUserId: string, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: channelUserId, text });
  }

  async indicateTyping(channelUserId: string): Promise<void> {
    try {
      await this.call('sendChatAction', { chat_id: channelUserId, action: 'typing' });
    } catch {
      // Cosmetic. Never let it take down a turn that would otherwise succeed.
    }
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${API_BASE}/bot${this.options.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // The bot token is in the URL, not the body, so this is safe to log.
      throw new Error(`Telegram ${method} failed (${response.status}): ${detail.slice(0, 200)}`);
    }
  }
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    text?: string;
    from?: { is_bot?: boolean };
    chat?: { id?: number; type?: string };
  };
}
