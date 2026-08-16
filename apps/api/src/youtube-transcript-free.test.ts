import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchTranscriptMock = vi.hoisted(() => vi.fn());
vi.mock('youtube-transcript-plus', () => ({ fetchTranscript: fetchTranscriptMock }));

const { FreeTranscriptSource, ChainedTranscriptSource } =
  await import('./youtube-transcript-free.js');

afterEach(() => fetchTranscriptMock.mockReset());

describe('FreeTranscriptSource', () => {
  it('joins the segments into one transcript', async () => {
    fetchTranscriptMock.mockResolvedValue([{ text: 'We are no strangers' }, { text: 'to love' }]);

    expect(await new FreeTranscriptSource().fetch('abc')).toEqual({
      ok: true,
      text: 'We are no strangers to love',
      language: null,
    });
  });

  it('decodes the escaped entities the library leaves in', async () => {
    // Measured: the library returns "We&#39;re" rather than "We're".
    fetchTranscriptMock.mockResolvedValue([{ text: 'We&#39;re no strangers &amp; more' }]);

    const result = await new FreeTranscriptSource().fetch('abc');
    expect(result).toMatchObject({ ok: true, text: "We're no strangers & more" });
  });

  /**
   * The load-bearing behaviour, and the reason this class exists rather than
   * the library being used directly.
   *
   * YouTube bot-walls this server per video. Measured on three: one served
   * caption tracks normally, two returned 1.1MB of HTML saying "Sign in to
   * confirm you're not a bot" with no tracks. The library cannot tell those
   * apart and reports BOTH as "No transcripts are available for the video".
   *
   * Passing that wording through would have the agent telling a student their
   * video has no transcript while YouTube is showing them one. So a failure
   * here is always service-unavailable, which lets the chain fall through.
   */
  it('never claims a video has no captions', async () => {
    fetchTranscriptMock.mockRejectedValue(
      new Error('No transcripts are available for the video with ID "Lgq0KXYptLA"'),
    );

    expect(await new FreeTranscriptSource().fetch('Lgq0KXYptLA')).toEqual({
      ok: false,
      reason: 'service-unavailable',
    });
  });

  it('treats an empty transcript as a failure, not an empty video', async () => {
    fetchTranscriptMock.mockResolvedValue([]);
    expect(await new FreeTranscriptSource().fetch('abc')).toEqual({
      ok: false,
      reason: 'service-unavailable',
    });
  });
});

describe('ChainedTranscriptSource', () => {
  const succeeds = { fetch: async () => ({ ok: true, text: 'got it', language: 'en' }) };
  const unavailable = { fetch: async () => ({ ok: false, reason: 'service-unavailable' }) };
  const noCaptions = { fetch: async () => ({ ok: false, reason: 'none-available' }) };

  it('falls through to the paid source when the free one is walled', async () => {
    const chain = new ChainedTranscriptSource([unavailable, succeeds] as never);
    expect(await chain.fetch('abc')).toMatchObject({ ok: true, text: 'got it' });
  });

  it('stops at the first success, so the paid credit is never spent', async () => {
    const paid = { fetch: vi.fn() };
    const chain = new ChainedTranscriptSource([succeeds, paid] as never);

    await chain.fetch('abc');
    expect(paid.fetch).not.toHaveBeenCalled();
  });

  /**
   * "No captions" is a fact about the video, not a failure of the source, so
   * asking a second service spends a credit to be told the same thing.
   */
  it('does not pay to re-confirm a video genuinely has no captions', async () => {
    const paid = { fetch: vi.fn() };
    const chain = new ChainedTranscriptSource([noCaptions, paid] as never);

    expect(await chain.fetch('abc')).toEqual({ ok: false, reason: 'none-available' });
    expect(paid.fetch).not.toHaveBeenCalled();
  });

  it('reports unavailable when every source is', async () => {
    const chain = new ChainedTranscriptSource([unavailable, unavailable] as never);
    expect(await chain.fetch('abc')).toEqual({ ok: false, reason: 'service-unavailable' });
  });
});
