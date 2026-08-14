/**
 * Turning Google links into embeddable previews.
 *
 * The useful property here: Google's /preview endpoints authenticate with the
 * VIEWER'S existing browser session, not with our OAuth token. A student who
 * can open the file in Drive can see it embedded, which means real file
 * viewing without Drive scopes -- those are restricted and carry an annual
 * CASA assessment.
 *
 * The tradeoff is that we cannot read the file server-side, so the agent still
 * cannot reason about contents. This makes the file visible to the student,
 * not to the model.
 */

/** Google editor products that expose a /preview route. */
const DOC_TYPES = ['document', 'presentation', 'spreadsheets', 'forms'] as const;

export interface PreviewTarget {
  /** URL safe to put in an iframe. */
  embedUrl: string;
  /** Original link, for "open in Google" and as the fallback. */
  sourceUrl: string;
  label: string;
}

/**
 * Returns an embeddable preview for a Google link, or null.
 *
 * Null is the common case and must stay cheap: Classroom permalinks, folders,
 * and arbitrary links are all non-embeddable and should just open normally
 * rather than loading a pane that renders Google's "refused to connect".
 */
export function toPreviewTarget(rawUrl: string, label?: string): PreviewTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const name = label?.trim() || 'Attachment';

  // drive.google.com/file/d/<id>/view  ->  /preview
  if (url.hostname === 'drive.google.com') {
    const fileMatch = /^\/file\/d\/([^/]+)/.exec(url.pathname);
    if (fileMatch?.[1]) {
      return {
        embedUrl: `https://drive.google.com/file/d/${fileMatch[1]}/preview`,
        sourceUrl: rawUrl,
        label: name,
      };
    }
    // Folders have no preview route -- embedding one shows an error frame.
    return null;
  }

  // docs.google.com/<type>/d/<id>/edit  ->  /preview
  if (url.hostname === 'docs.google.com') {
    const docMatch = /^\/([a-z]+)\/d\/([^/]+)/.exec(url.pathname);
    const type = docMatch?.[1];
    const id = docMatch?.[2];
    if (type && id && (DOC_TYPES as readonly string[]).includes(type)) {
      return {
        embedUrl: `https://docs.google.com/${type}/d/${id}/preview`,
        sourceUrl: rawUrl,
        label: name,
      };
    }
    return null;
  }

  // YouTube, for videos teachers attach to materials.
  if (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com') {
    const videoId = url.searchParams.get('v');
    if (videoId) {
      return {
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        sourceUrl: rawUrl,
        label: name,
      };
    }
    return null;
  }
  if (url.hostname === 'youtu.be' && url.pathname.length > 1) {
    return {
      embedUrl: `https://www.youtube.com/embed/${url.pathname.slice(1)}`,
      sourceUrl: rawUrl,
      label: name,
    };
  }

  return null;
}

export interface TextSegment {
  type: 'text';
  value: string;
}
export interface LinkSegment {
  type: 'link';
  label: string;
  url: string;
  preview: PreviewTarget | null;
}
export type Segment = TextSegment | LinkSegment;

const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /(https?:\/\/[^\s<>"')\]]+)/g;

/**
 * Split assistant text into plain runs and links.
 *
 * Deliberately not a markdown library. The model emits `[title](url)` and bare
 * URLs; everything else in the message is prose the student should read as
 * written. Pulling in a full renderer would also mean sanitising arbitrary
 * HTML, which is a real XSS surface for text that ultimately originates from
 * a teacher's course materials.
 */
export function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    if (!value) return;
    // Find bare URLs inside the plain runs too.
    let last = 0;
    for (const match of value.matchAll(BARE_URL)) {
      const url = match[0];
      const start = match.index;
      if (start > last) segments.push({ type: 'text', value: value.slice(last, start) });
      segments.push({ type: 'link', label: url, url, preview: toPreviewTarget(url) });
      last = start + url.length;
    }
    if (last < value.length) segments.push({ type: 'text', value: value.slice(last) });
  };

  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const [full, label, url] = match;
    if (!label || !url) continue;
    if (match.index > cursor) pushText(text.slice(cursor, match.index));
    segments.push({ type: 'link', label, url, preview: toPreviewTarget(url, label) });
    cursor = match.index + full.length;
  }

  pushText(text.slice(cursor));
  return segments;
}
