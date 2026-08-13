import { describe, expect, it } from 'vitest';
import { TelegramChannel } from './channel.js';

const SECRET = 'a'.repeat(32);
const channel = new TelegramChannel({ botToken: 'unused', webhookSecret: SECRET });

const headers = (value?: string) =>
  new Headers(value === undefined ? {} : { 'x-telegram-bot-api-secret-token': value });

const privateMessage = (text: string, chatId = 42) => ({
  update_id: 1,
  message: { text, chat: { id: chatId, type: 'private' }, from: { is_bot: false } },
});

describe('verifyRequest', () => {
  it('accepts the configured secret', () => {
    expect(channel.verifyRequest(headers(SECRET))).toBe(true);
  });

  it('rejects a missing header', () => {
    // Without this, the webhook URL alone is enough to drive someone's agent.
    expect(channel.verifyRequest(headers())).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(channel.verifyRequest(headers('b'.repeat(32)))).toBe(false);
    expect(channel.verifyRequest(headers(''))).toBe(false);
    expect(channel.verifyRequest(headers(SECRET.slice(0, -1)))).toBe(false);
  });
});

describe('parse', () => {
  it('accepts a private text message', () => {
    expect(channel.parse(privateMessage('hello', 99))).toEqual({
      channelUserId: '99',
      text: 'hello',
      externalId: '1',
    });
  });

  /**
   * The one that matters most. A bot added to a group would otherwise answer
   * with one student's agent -- their calendar, their coursework, their memory
   * -- in front of everyone else in the room.
   */
  it('ignores group and supergroup chats', () => {
    for (const type of ['group', 'supergroup', 'channel']) {
      expect(
        channel.parse({
          update_id: 2,
          message: { text: 'hi', chat: { id: 7, type }, from: { is_bot: false } },
        }),
      ).toBeNull();
    }
  });

  it('ignores messages from other bots', () => {
    expect(
      channel.parse({
        update_id: 3,
        message: { text: 'hi', chat: { id: 7, type: 'private' }, from: { is_bot: true } },
      }),
    ).toBeNull();
  });

  it('ignores non-text updates', () => {
    // Photos, stickers, edited messages, and callback queries all arrive here.
    expect(
      channel.parse({ update_id: 4, message: { chat: { id: 7, type: 'private' } } }),
    ).toBeNull();
    expect(channel.parse({ update_id: 5, edited_message: { text: 'x' } })).toBeNull();
    expect(channel.parse({ update_id: 6 })).toBeNull();
  });

  it('survives malformed input without throwing', () => {
    // The webhook must never 500 on garbage -- Telegram would just retry it.
    for (const body of [null, undefined, 'string', 42, [], {}, { message: null }]) {
      expect(() => channel.parse(body)).not.toThrow();
      expect(channel.parse(body)).toBeNull();
    }
  });

  it('uses the chat id, not the user id, as the reply address', () => {
    // sendMessage takes chat_id. Storing a user id would parse fine and then
    // fail to deliver every reply.
    const parsed = channel.parse({
      update_id: 7,
      message: {
        text: 'hi',
        chat: { id: 1111, type: 'private' },
        from: { is_bot: false, id: 2222 },
      },
    });
    expect(parsed?.channelUserId).toBe('1111');
  });
});
