import type { TranscriptOutcome, YoutubeTranscriptSource } from '@contexto/agent';

/**
 * Transcripts via TranscriptAPI.
 *
 * A third party is involved because nothing on this server can reach YouTube
 * captions -- see the note at the top of tools/web/youtube.ts for the routes
 * that were measured and closed. The service runs the residential pool we
 * would otherwise have to rent.
 *
 * Vendor specifics live only in this file. Swapping to another provider means
 * writing another YoutubeTranscriptSource, not touching the tool.
 */
const ENDPOINT = 'https://transcriptapi.com/api/v2/youtube/transcript';

/** Documented as retryable: transient bot detection, rate limit, or outage. */
const RETRYABLE = new Set([408, 429, 503]);
const MAX_ATTEMPTS = 3;

export class TranscriptApiSource implements YoutubeTranscriptSource {
  constructor(private readonly apiKey: string) {}

  async fetch(videoId: string): Promise<TranscriptOutcome> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        const url =
          `${ENDPOINT}?video_url=${encodeURIComponent(videoId)}` +
          '&format=text&include_timestamp=false';
        response = await fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      } catch {
        return { ok: false, reason: 'service-unavailable' };
      }

      if (response.ok) {
        const body = (await response.json().catch(() => null)) as {
          transcript?: unknown;
          language?: string;
        } | null;

        // format=text makes transcript a string; anything else is a contract
        // change on their side and must not be handed to the model as text.
        const text = typeof body?.transcript === 'string' ? body.transcript.trim() : '';
        if (!text) return { ok: false, reason: 'none-available' };

        return { ok: true, text, language: body?.language ?? null };
      }

      /*
       * 404 means this video has no captions -- a fact about the video, not a
       * failure, and the student should be told plainly rather than sent to
       * try again. Everything else is our problem: 401 a bad key, 402 no
       * credits, 422 a malformed id.
       */
      if (response.status === 404) return { ok: false, reason: 'none-available' };

      if (!RETRYABLE.has(response.status) || attempt === MAX_ATTEMPTS) {
        return { ok: false, reason: 'service-unavailable' };
      }

      // Honour Retry-After when given; otherwise back off gently. Failed
      // requests are not billed, so a retry costs nothing but time.
      const after = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : attempt * 1200;
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 5000)));
    }

    return { ok: false, reason: 'service-unavailable' };
  }
}
