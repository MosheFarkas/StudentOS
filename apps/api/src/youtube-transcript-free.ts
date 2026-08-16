import { fetchTranscript } from 'youtube-transcript-plus';
import type { TranscriptOutcome, YoutubeTranscriptSource } from '@contexto/agent';

/**
 * Transcripts straight from YouTube, no key, no cost.
 *
 * Tried first because when it works it is free, and it does work: measured
 * from this droplet it returned a full transcript for a video whose watch
 * page came back unwalled.
 *
 * It is unreliable in a specific and dangerous way, which is why it is never
 * the only source. YouTube bot-walls this server PER VIDEO, not globally --
 * measured on three videos, one served captionTracks normally while two
 * returned 1.1MB of HTML containing "Sign in to confirm you're not a bot" and
 * no tracks at all. The library cannot tell those apart and reports both as
 * "No transcripts are available for the video".
 *
 * So a failure here NEVER means the video has no captions, and this class
 * must never say so: it reports service-unavailable, which lets the chain
 * fall through to a paid source with a residential IP. Trusting the
 * library's wording would have the agent telling a student their video has
 * no transcript while YouTube shows them one.
 */
export class FreeTranscriptSource implements YoutubeTranscriptSource {
  async fetch(videoId: string): Promise<TranscriptOutcome> {
    try {
      const segments = await fetchTranscript(videoId);
      const text = segments
        .map((segment) => segment.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) return { ok: false, reason: 'service-unavailable' };
      return { ok: true, text: decodeEntities(text), language: null };
    } catch {
      // Deliberately not 'none-available'. See the note above.
      return { ok: false, reason: 'service-unavailable' };
    }
  }
}

/** The library returns caption text still HTML-escaped: &#39; for an apostrophe. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'");
}

/**
 * Tries each source in turn, cheapest first.
 *
 * Stops at the first transcript, and at the first source that says the video
 * genuinely has no captions -- that is a fact about the video, so asking a
 * second service would spend a credit to be told the same thing.
 */
export class ChainedTranscriptSource implements YoutubeTranscriptSource {
  constructor(private readonly sources: readonly YoutubeTranscriptSource[]) {}

  async fetch(videoId: string): Promise<TranscriptOutcome> {
    let last: TranscriptOutcome = { ok: false, reason: 'service-unavailable' };

    for (const source of this.sources) {
      const outcome = await source.fetch(videoId);
      if (outcome.ok) return outcome;
      if (outcome.reason === 'none-available') return outcome;
      last = outcome;
    }
    return last;
  }
}
