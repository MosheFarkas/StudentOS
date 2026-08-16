import { z } from 'zod';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';

/**
 * What the agent can learn about a YouTube video a teacher assigned.
 *
 * Read this before trying to add transcripts, because the obvious routes are
 * all closed and were each measured rather than assumed:
 *
 *   captions.download on the Data API requires the video's OWNER to
 *   authorise. A student is not the owner of their teacher's video, so no
 *   scope a student can grant will ever open it.
 *
 *   Scraping the caption endpoint returns zero bytes from a datacenter IP.
 *   yt-dlp does handle the obfuscation, but from this droplet every player
 *   client -- default, web_safari, tv, ios, with and without a JS runtime --
 *   answers "Sign in to confirm you're not a bot", including for plain
 *   metadata. Cookies would work and would mean pinning a real YouTube
 *   account to the server, which is both fragile and against YouTube's terms.
 *
 * So this returns what a video IS, not what is said in it: title, channel,
 * description, duration. For teaching material the description is often a
 * real summary, and knowing a link is a Radio-Canada news piece about road
 * salt lets the agent talk about it usefully instead of pretending.
 */

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

const inputSchema = z.object({
  url: z.string().min(1).describe('YouTube link or video id, e.g. from a Classroom attachment'),
});

export const readYoutubeVideo: Tool<z.infer<typeof inputSchema>, unknown> = {
  id: 'youtube_video_details',
  description:
    'Look up what a YouTube video is: its title, channel, description, and length. Use this ' +
    'for YouTube attachments in Classroom so you can tell the student what a video covers. ' +
    'You CANNOT get a transcript or hear the video -- say so plainly rather than implying you ' +
    'watched it, and do not guess at its contents beyond the description.',
  inputSchema,

  async execute({ url }, ctx) {
    const videoId = parseVideoId(url);
    if (!videoId) return unavailable('That does not look like a YouTube link.');

    if (!ctx.youtube) {
      return unavailable('YouTube lookups are not configured on this server.');
    }

    const video = await ctx.youtube.lookup(videoId);
    if (!video) {
      return unavailable('That video does not exist, or it is private.');
    }

    return {
      videoId,
      title: video.title,
      channel: video.channel,
      description: video.description,
      durationSeconds: video.durationSeconds,
      publishedAt: video.publishedAt,
      link: `https://www.youtube.com/watch?v=${videoId}`,
      /*
       * Stated in the payload, not just the tool description, because the
       * failure worth preventing is the model summarising a video it never
       * heard. The student can watch it; the agent cannot.
       */
      note:
        'This is the video description and metadata only -- I have not watched or heard it. ' +
        'Do not describe what happens in the video beyond what is written here.',
    };
  },
};
