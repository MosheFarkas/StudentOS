import type { YoutubeMetadataSource, YoutubeVideo } from '@contexto/agent';

/**
 * Video metadata, by the official API where possible.
 *
 * Two sources, because the good one needs a console step the deployment may
 * not have taken yet:
 *
 *   Data API v3 -- title, channel, description, duration. Needs the API
 *   enabled and a key that is allowed to call it.
 *
 *   oEmbed -- title and channel only, no key, always available. Measured
 *   working on a real teacher-posted video while the Data API was still
 *   disabled, which is why it is worth keeping as a fallback rather than
 *   failing outright: a title and channel still lets the agent say what a
 *   link is.
 */
export class GoogleYoutubeMetadata implements YoutubeMetadataSource {
  constructor(private readonly apiKey: string | undefined) {}

  async lookup(videoId: string): Promise<YoutubeVideo | null> {
    if (this.apiKey) {
      const viaApi = await this.fromDataApi(videoId);
      if (viaApi) return viaApi;
    }
    return await this.fromOembed(videoId);
  }

  private async fromDataApi(videoId: string): Promise<YoutubeVideo | null> {
    try {
      const url =
        'https://www.googleapis.com/youtube/v3/videos' +
        `?part=snippet,contentDetails&id=${encodeURIComponent(videoId)}&key=${this.apiKey}`;
      const response = await fetch(url);
      if (!response.ok) return null;

      const body = (await response.json()) as {
        items?: {
          snippet?: {
            title?: string;
            description?: string;
            channelTitle?: string;
            publishedAt?: string;
          };
          contentDetails?: { duration?: string };
        }[];
      };

      const item = body.items?.[0];
      if (!item?.snippet) return null;

      return {
        title: item.snippet.title ?? 'Untitled',
        channel: item.snippet.channelTitle ?? null,
        description: item.snippet.description ?? null,
        durationSeconds: parseIsoDuration(item.contentDetails?.duration),
        publishedAt: item.snippet.publishedAt ?? null,
      };
    } catch {
      // A failure here falls through to oEmbed rather than ending the lookup.
      return null;
    }
  }

  private async fromOembed(videoId: string): Promise<YoutubeVideo | null> {
    try {
      const target = `https://www.youtube.com/watch?v=${videoId}`;
      const response = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`,
      );
      if (!response.ok) return null;

      const body = (await response.json()) as { title?: string; author_name?: string };
      if (!body.title) return null;

      return {
        title: body.title,
        channel: body.author_name ?? null,
        description: null,
        durationSeconds: null,
        publishedAt: null,
      };
    } catch {
      return null;
    }
  }
}

/** ISO 8601 durations, which is how the Data API reports length: PT4M13S. */
export function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;

  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return total > 0 ? total : null;
}
