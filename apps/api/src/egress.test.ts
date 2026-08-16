import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayEgress } from './egress.js';

afterEach(() => vi.unstubAllGlobals());

describe('relay egress', () => {
  it('wraps a request into the relay envelope and unwraps the response', async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
      sent = { url: String(url), init };
      return new Response(
        JSON.stringify({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"hello":"world"}').toString('base64'),
        }),
        { status: 200 },
      );
    });

    const egress = createRelayEgress('https://relay.example.com', 'secret-token');
    const response = await egress.fetch('https://www.youtube.com/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"videoId":"abc"}',
    });

    expect(await response.json()).toEqual({ hello: 'world' });

    const payload = JSON.parse(String(sent!.init.body)) as Record<string, unknown>;
    expect(sent!.url).toBe('https://relay.example.com/fetch');
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret-token',
    );
    expect(payload.url).toBe('https://www.youtube.com/x');
    expect(payload.method).toBe('POST');
    expect(payload.body).toBe('{"videoId":"abc"}');
  });

  /**
   * The relay being unreachable has to look like a failed request, not an
   * unfamiliar exception -- the transcript chain treats a throw as "this
   * source did not work" and moves to the next tier, which is exactly the
   * behaviour wanted when the machine at home is off.
   */
  it('throws when the relay refuses, so the chain falls through', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 502 }));

    const egress = createRelayEgress('https://relay.example.com', 'token');
    await expect(egress.fetch('https://example.com/')).rejects.toThrow(/502/);
  });

  describe('healthy', () => {
    it('is true when the relay answers its health endpoint', async () => {
      vi.stubGlobal('fetch', async (url: URL | string) => {
        expect(String(url)).toBe('https://relay.example.com/health');
        return new Response('{"ok":true}', { status: 200 });
      });

      expect(await createRelayEgress('https://relay.example.com', 't').healthy()).toBe(true);
    });

    /** The machine at home being off is the common case, not an error. */
    it('is false rather than throwing when the machine is off', async () => {
      vi.stubGlobal('fetch', async () => {
        throw new Error('ECONNREFUSED');
      });

      expect(await createRelayEgress('https://relay.example.com', 't').healthy()).toBe(false);
    });
  });
});
