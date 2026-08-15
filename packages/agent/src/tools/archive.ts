import { unzipSync } from 'fflate';

/**
 * Reading zip files, and the Office formats that are secretly zip files.
 *
 * .docx and .pptx are both a zip of XML, so one primitive covers three
 * problems: the archives teachers post, the Word documents, and the
 * PowerPoint decks.
 *
 * Everything here processes untrusted input, so the caps below are load
 * bearing rather than tidy. A zip bomb is a few kilobytes that decompresses
 * to gigabytes, and this runs inside a 512MB cgroup shared with the rest of
 * the service.
 */

/** Total decompressed bytes we will hold, across all entries. */
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 400;

export interface ArchiveEntry {
  path: string;
  bytes: Uint8Array;
}

export class ArchiveError extends Error {}

/**
 * Decompress a zip, refusing anything that expands unreasonably.
 *
 * fflate is synchronous and CPU-bound. That is acceptable at these sizes and
 * with the caps below; it would not be for arbitrary uploads.
 */
export function readZip(bytes: Uint8Array): ArchiveEntry[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new ArchiveError('That file is not a readable zip archive.');
  }

  const entries: ArchiveEntry[] = [];
  let total = 0;

  for (const [path, content] of Object.entries(files)) {
    // Directory markers carry no content.
    if (path.endsWith('/') || content.length === 0) continue;

    total += content.length;
    if (total > MAX_TOTAL_BYTES || entries.length >= MAX_ENTRIES) {
      throw new ArchiveError('That archive is too large to open.');
    }
    entries.push({ path, bytes: content });
  }

  return entries;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Strip XML to its text.
 *
 * Office XML wraps every run of text in its own element, so naive tag
 * stripping glues words together across those boundaries. Paragraph and
 * line-break elements become newlines first, and each text run gets a
 * separator, so "Hello" + "world" does not come back as "Helloworld".
 */
function xmlToText(xml: string): string {
  let text = xml.replace(/<(w:p|a:p|w:br|a:br|w:tab)\b[^>]*\/?>/g, '\n');
  text = text.replace(/<\/(w:p|a:p)>/g, '\n');
  // Word and PowerPoint both put literal text in <w:t> / <a:t>.
  text = text.replace(/<\/(w:t|a:t)>/g, ' ');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  text = text.replace(/[^\S\n]+/g, ' ');
  text = text.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Text of a .docx. */
export function readDocx(bytes: Uint8Array): string {
  const entries = readZip(bytes);
  const body = entries.find((entry) => entry.path === 'word/document.xml');
  if (!body) throw new ArchiveError('That Word file has no readable document inside it.');
  return xmlToText(decoder.decode(body.bytes));
}

/**
 * Text of a .pptx, slide by slide.
 *
 * Slides are numbered without padding, so slide10 sorts before slide2 under a
 * plain string sort and the deck comes back shuffled. Compared numerically so
 * the order matches what the student sees.
 */
export function readPptx(bytes: Uint8Array): string {
  const entries = readZip(bytes);
  const slideNumber = (path: string) => Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? 0);

  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.path))
    .sort((a, b) => slideNumber(a.path) - slideNumber(b.path));

  if (slides.length === 0) {
    throw new ArchiveError('That PowerPoint file has no readable slides inside it.');
  }

  return slides
    .map((slide, index) => {
      const text = xmlToText(decoder.decode(slide.bytes));
      return text ? `[Slide ${index + 1}]\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}
