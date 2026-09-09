import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tools/types.js';
import { collectSchoolMail } from './collect-mail.js';

/**
 * The collector fetches only what the vault lacks.
 *
 * Every pass used to fetch a year of bodies and then throw most of them away
 * once the importer saw the ids were already episodes. Eight minutes a pass
 * on a real inbox, all of it for nothing on a quiet day.
 */

const ctx = {
  userId: 'u',
  agentId: 'u',
  google: { getAccessToken: async () => 'token', hasScope: () => true },
} as unknown as ToolContext;

function gmail(listed: string[]) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/messages?')) {
      return new Response(JSON.stringify({ messages: listed.map((id) => ({ id })) }));
    }
    const id = url.match(/\/messages\/([^?]+)/)?.[1] ?? '';
    return new Response(
      JSON.stringify({
        id,
        payload: {
          headers: [
            { name: 'From', value: 'Teacher <t@school.org>' },
            { name: 'Subject', value: `about ${id}` },
            { name: 'Date', value: 'Mon, 1 Sep 2026 09:00:00 +0000' },
          ],
          body: { data: Buffer.from('hello').toString('base64url') },
        },
      }),
    );
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('collecting school mail', () => {
  it('does not fetch a body the vault already holds', async () => {
    const fetch = gmail(['a', 'b', 'c']);
    vi.stubGlobal('fetch', fetch);

    const found = await collectSchoolMail(ctx, {
      domains: ['school.org'],
      newerThan: '2d',
      skip: new Set(['a', 'c']),
    });

    const fetched = fetch.mock.calls.map(([url]) => String(url));
    expect(fetched.some((url) => url.includes('/messages/b?'))).toBe(true);
    expect(fetched.some((url) => url.includes('/messages/a?'))).toBe(false);
    expect(fetched.some((url) => url.includes('/messages/c?'))).toBe(false);
    expect(found.found).toBe(3);
    expect(found.known).toBe(2);
    expect(found.messages.map((m) => m.messageId)).toEqual(['b']);
  });

  it('asks for the window it was given', async () => {
    const fetch = gmail([]);
    vi.stubGlobal('fetch', fetch);
    await collectSchoolMail(ctx, { domains: ['school.org'], newerThan: '2d' });
    expect(decodeURIComponent(String(fetch.mock.calls[0]?.[0]))).toContain('newer_than:2d');
  });
});
