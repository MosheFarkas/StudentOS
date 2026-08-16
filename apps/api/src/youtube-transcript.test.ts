import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptApiSource } from './youtube-transcript.js';

function reply(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

afterEach(() => vi.unstubAllGlobals());

describe('TranscriptApiSource', () => {
  it('returns the transcript text', async () => {
    vi.stubGlobal('fetch', async () =>
      reply(200, { video_id: 'x', language: 'fr', transcript: 'Le sel de voirie...' }),
    );

    const result = await new TranscriptApiSource('k').fetch('Lgq0KXYptLA');
    expect(result).toEqual({ ok: true, text: 'Le sel de voirie...', language: 'fr' });
  });

  it('sends the key as a bearer token and asks for plain text', async () => {
    let seen: { url: string; auth: string } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen = { url, auth: String((init.headers as Record<string, string>).Authorization) };
      return reply(200, { transcript: 'ok' });
    });

    await new TranscriptApiSource('secret').fetch('abc');
    expect(seen!.auth).toBe('Bearer secret');
    expect(seen!.url).toContain('format=text');
  });

  /**
   * The distinction the student experiences. A video with no captions is a
   * fact about the video and nothing they can act on; a bad key or exhausted
   * credits is ours, and must not be reported as "this video has no
   * transcript" -- that would send them looking for another source when the
   * fix is on our side.
   */
  it('reads 404 as the video simply having no captions', async () => {
    vi.stubGlobal('fetch', async () => reply(404, { detail: 'No transcript available' }));
    expect(await new TranscriptApiSource('k').fetch('abc')).toEqual({
      ok: false,
      reason: 'none-available',
    });
  });

  it.each([401, 402, 422, 500])('treats %i as our problem, not the video', async (status) => {
    vi.stubGlobal('fetch', async () => reply(status, { detail: 'nope' }));
    expect(await new TranscriptApiSource('k').fetch('abc')).toEqual({
      ok: false,
      reason: 'service-unavailable',
    });
  });

  /** Failed requests are not billed, so retrying transient errors is free. */
  it('retries a transient failure and succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls === 1
        ? reply(429, {}, { 'retry-after': '0' })
        : reply(200, { transcript: 'hi' });
    });

    const result = await new TranscriptApiSource('k').fetch('abc');
    expect(result).toMatchObject({ ok: true, text: 'hi' });
    expect(calls).toBe(2);
  });

  it('gives up rather than retrying forever', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return reply(503, {}, { 'retry-after': '0' });
    });

    expect(await new TranscriptApiSource('k').fetch('abc')).toEqual({
      ok: false,
      reason: 'service-unavailable',
    });
    expect(calls).toBe(3);
  });

  it('does not retry a permanent failure', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return reply(401, {});
    });

    await new TranscriptApiSource('k').fetch('abc');
    expect(calls).toBe(1);
  });

  /*
   * format=text promises a string. Anything else is a contract change on
   * their side, and must not reach the model as if it were a transcript.
   */
  it('refuses a transcript that is not a string', async () => {
    vi.stubGlobal('fetch', async () => reply(200, { transcript: [{ text: 'segmented' }] }));
    expect(await new TranscriptApiSource('k').fetch('abc')).toEqual({
      ok: false,
      reason: 'none-available',
    });
  });

  it('survives the network failing outright', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNRESET');
    });
    expect(await new TranscriptApiSource('k').fetch('abc')).toEqual({
      ok: false,
      reason: 'service-unavailable',
    });
  });
});
