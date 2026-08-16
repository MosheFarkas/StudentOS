import { describe, expect, it } from 'vitest';
import { parseVideoId, readYoutubeVideo } from './youtube.js';
import type { ToolContext } from '../types.js';

describe('parseVideoId', () => {
  it('handles every link shape Classroom produces', () => {
    // The first is a real teacher-posted attachment from a school account.
    expect(parseVideoId('https://www.youtube.com/watch?v=Lgq0KXYptLA')).toBe('Lgq0KXYptLA');
    expect(parseVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('keeps extra query parameters from confusing it', () => {
    expect(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLabc')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('rejects anything that is not a video link', () => {
    expect(parseVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseVideoId('https://www.youtube.com/@somechannel')).toBeNull();
    expect(parseVideoId('not a url')).toBeNull();
    expect(parseVideoId('')).toBeNull();
  });
});

const ctx = (
  lookup: (id: string) => Promise<unknown>,
  transcripts?: (id: string) => Promise<unknown>,
): ToolContext =>
  ({
    youtube: { lookup },
    ...(transcripts ? { youtubeTranscripts: { fetch: transcripts } } : {}),
  }) as unknown as ToolContext;

describe('readYoutubeVideo', () => {
  it('returns what the video is', async () => {
    const result = (await readYoutubeVideo.execute(
      { url: 'https://www.youtube.com/watch?v=Lgq0KXYptLA' },
      ctx(async () => ({
        title: 'Les rivières trop salées après le déneigement à Toronto',
        channel: 'Radio-Canada Info',
        description: 'Le sel de voirie se retrouve dans les cours d’eau.',
        durationSeconds: 132,
        publishedAt: '2025-02-01T00:00:00Z',
      })),
    )) as { title: string; note: string };

    expect(result.title).toContain('rivières');
    // No transcript source configured at all, so the agent must still be
    // told plainly that it has not heard the video.
    expect(result.note).toMatch(/NOT heard this video/i);
  });

  /**
   * The failure this guards against is the model summarising a video nobody
   * heard. Transcripts are unobtainable -- captions.download needs the
   * video's owner, and every scraping route answers YouTube's bot check from
   * a datacenter IP -- so the payload itself has to say so, not just the
   * tool description the model saw once.
   */
  it('warns against inventing contents, in the payload', async () => {
    const result = (await readYoutubeVideo.execute(
      { url: 'dQw4w9WgXcQ' },
      ctx(async () => ({
        title: 'A lesson',
        channel: null,
        description: null,
        durationSeconds: null,
        publishedAt: null,
      })),
    )) as { note: string };

    expect(result.note).toMatch(/do not describe what happens/i);
  });

  it('reports a bad link rather than guessing', async () => {
    const result = await readYoutubeVideo.execute(
      { url: 'https://example.com/' },
      ctx(async () => null),
    );
    expect((result as { reason: string }).reason).toContain('does not look like');
  });

  it('reports a missing or private video', async () => {
    const result = await readYoutubeVideo.execute(
      { url: 'dQw4w9WgXcQ' },
      ctx(async () => null),
    );
    expect((result as { reason: string }).reason).toContain('private');
  });

  it('says so when lookups are not configured at all', async () => {
    const result = await readYoutubeVideo.execute({ url: 'dQw4w9WgXcQ' }, {} as ToolContext);
    expect((result as { reason: string }).reason).toContain('not configured');
  });
});

describe('transcripts', () => {
  const video = async () => ({
    title: 'Les rivières trop salées',
    channel: 'Radio-Canada Info',
    description: 'Le sel de voirie.',
    durationSeconds: 132,
    publishedAt: null,
  });

  it('returns the transcript when one exists', async () => {
    const result = (await readYoutubeVideo.execute(
      { url: 'Lgq0KXYptLA' },
      ctx(video, async () => ({
        ok: true,
        text: 'Le sel se retrouve dans les rivieres.',
        language: 'fr',
      })),
    )) as { transcript: string; title: string; note?: string };

    expect(result.transcript).toContain('rivieres');
    // The "I have not heard this" warning must not survive a real transcript.
    expect(result.note).toBeUndefined();
    expect(result.title).toContain('rivières');
  });

  /**
   * Metadata is free and a transcript is billed, so losing the transcript
   * must still leave a usable answer rather than failing the whole lookup.
   */
  it('keeps the metadata when the transcript is unavailable', async () => {
    const result = (await readYoutubeVideo.execute(
      { url: 'Lgq0KXYptLA' },
      ctx(video, async () => ({ ok: false, reason: 'none-available' })),
    )) as { transcript: null; title: string; note: string };

    expect(result.transcript).toBeNull();
    expect(result.title).toContain('rivières');
    expect(result.note).toMatch(/NOT heard/);
    expect(result.note).toMatch(/no transcript available/i);
  });

  /** A service problem must not be reported as a fact about the video. */
  it('distinguishes our outage from a video with no captions', async () => {
    const result = (await readYoutubeVideo.execute(
      { url: 'Lgq0KXYptLA' },
      ctx(video, async () => ({ ok: false, reason: 'service-unavailable' })),
    )) as { note: string };

    expect(result.note).toMatch(/could not reach the transcript service/i);
    expect(result.note).not.toMatch(/no transcript available/i);
  });

  it('truncates a very long transcript', async () => {
    const result = (await readYoutubeVideo.execute(
      { url: 'Lgq0KXYptLA' },
      ctx(video, async () => ({ ok: true, text: 'x'.repeat(60_000), language: 'en' })),
    )) as { transcript: string; truncated: boolean };

    expect(result.truncated).toBe(true);
    expect(result.transcript.length).toBe(40_000);
  });
});
