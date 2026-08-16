import { z } from 'zod';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';

/**
 * Reading a YouTube video a teacher assigned.
 *
 * Returns the transcript when one can be had, and metadata regardless.
 *
 * WHY A THIRD PARTY IS INVOLVED. The transcript is plainly visible in
 * YouTube's own UI, so it exists -- but nothing reaches it from this server.
 * Every route was measured from the production droplet, not assumed:
 *
 *   captions.download on the Data API requires the video's OWNER to
 *   authorise. A student is not the owner of a teacher's video, so no scope
 *   a student can grant will ever open it.
 *
 *   The watch page itself comes back bot-walled: 1.1MB of HTML with no
 *   captionTracks and "Sign in to confirm you're not a bot" in it. The
 *   timedtext endpoint returns zero bytes, and innertube's get_transcript
 *   returns 400.
 *
 *   yt-dlp handles YouTube's obfuscation properly, and still fails here on
 *   every player client (default, web_safari, tv, ios), with and without a
 *   JS runtime, and with curl_cffi TLS impersonation as Chrome, Safari and
 *   Firefox. The block is the DATACENTER IP, not the client fingerprint, so
 *   no amount of pretending to be a browser changes it.
 *
 * What is left is a residential IP. Cookies from a real YouTube account
 * would work and would mean pinning a personal account to a server used by
 * minors. A transcript service runs the residential pool instead, which is
 * why this takes a key.
 *
 * Without a key configured the tool still answers with title, channel,
 * description and length -- and says plainly that it has not heard the video.
 */

/**
 * Supplies transcripts. Implemented in apps/api, where the key lives.
 *
 * Separate from metadata because the two have different failure modes and
 * different costs: metadata is free and nearly always available, a transcript
 * is billed and may simply not exist for a given video.
 */
export interface YoutubeTranscriptSource {
  fetch(videoId: string): Promise<TranscriptOutcome>;
}

export type TranscriptOutcome =
  | { ok: true; text: string; language: string | null }
  /** The video genuinely has no captions. Not a fault the student can fix. */
  | { ok: false; reason: 'none-available' }
  /** Our key, credits, or the service. The student did nothing wrong. */
  | { ok: false; reason: 'service-unavailable' };

/** Supplies video metadata. Implemented in apps/api, where any key lives. */
export interface YoutubeMetadataSource {
  /** Null when the video does not exist or is private. */
  lookup(videoId: string): Promise<YoutubeVideo | null>;
}

export interface YoutubeVideo {
  title: string;
  channel: string | null;
  description: string | null;
  /** Absent from the keyless fallback. */
  durationSeconds: number | null;
  publishedAt: string | null;
}

/** Extract the id from any shape of YouTube link, or null. */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  // A bare id, as Classroom sometimes stores it.
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    // /embed/<id> and /shorts/<id>
    const match = /^\/(embed|shorts|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
    if (match?.[2]) return match[2];
  }
  return null;
}

/** Matches the Drive reader: enough to answer from, not enough to flood context. */
const MAX_TRANSCRIPT_CHARS = 40_000;

const inputSchema = z.object({
  url: z.string().min(1).describe('YouTube link or video id, e.g. from a Classroom attachment'),
});

export const readYoutubeVideo: Tool<z.infer<typeof inputSchema>, unknown> = {
  id: 'youtube_video_details',
  description:
    'Read a YouTube video: its transcript where one exists, plus title, channel, description ' +
    'and length. Use this for YouTube attachments in Classroom, and to answer questions about ' +
    'what a video says. When no transcript comes back you have NOT heard the video -- say so ' +
    'rather than describing it from the title.',
  inputSchema,

  async execute({ url }, ctx) {
    const videoId = parseVideoId(url);
    if (!videoId) return unavailable('That does not look like a YouTube link.');

    if (!ctx.youtube) {
      return unavailable('YouTube lookups are not configured on this server.');
    }

    /*
     * Both at once. A transcript alone loses the title and channel a student
     * needs to recognise the video, and metadata is free where a transcript
     * is billed, so a transcript failure must still leave a useful answer.
     */
    const [video, transcript] = await Promise.all([
      ctx.youtube.lookup(videoId),
      ctx.youtubeTranscripts?.fetch(videoId) ?? Promise.resolve(null),
    ]);

    if (!video && (!transcript || !transcript.ok)) {
      return unavailable('That video does not exist, or it is private.');
    }

    const base = {
      videoId,
      title: video?.title ?? null,
      channel: video?.channel ?? null,
      description: video?.description ?? null,
      durationSeconds: video?.durationSeconds ?? null,
      publishedAt: video?.publishedAt ?? null,
      link: `https://www.youtube.com/watch?v=${videoId}`,
    };

    if (transcript?.ok) {
      const tooLong = transcript.text.length > MAX_TRANSCRIPT_CHARS;
      return {
        ...base,
        language: transcript.language,
        truncated: tooLong,
        transcript: tooLong ? transcript.text.slice(0, MAX_TRANSCRIPT_CHARS) : transcript.text,
      };
    }

    /*
     * Stated in the payload, not only in the tool description, because the
     * failure worth preventing is the model summarising a video nobody heard.
     * The two reasons are kept apart: a video with no captions is nothing the
     * student can act on, whereas a service problem is ours.
     */
    return {
      ...base,
      transcript: null,
      note:
        transcript?.reason === 'service-unavailable'
          ? 'I could not reach the transcript service, so I have only the description here. ' +
            'I have NOT heard this video -- do not describe what happens in it.'
          : 'This video has no transcript available, so I have only the description here. ' +
            'I have NOT heard this video -- do not describe what happens in it.',
    };
  },
};
