import { extractText } from 'unpdf';

/**
 * Pulling text out of a PDF, and deciding whether there was any.
 *
 * Shared by the Drive reader and the link reader so a file gives the same
 * answer however the student reached it.
 *
 * The interesting part is telling a SCAN from a short document. Scanned
 * worksheets are everywhere in schools: they are images in a PDF wrapper and
 * extract to nothing, and reporting that as an empty document reads as our
 * bug rather than as a file needing OCR.
 *
 * The first attempt used a flat 20-character floor, which was wrong -- it
 * called a real one-page PDF containing "Dummy PDF file" a scan. Length alone
 * cannot separate the two, because a short document is genuinely short.
 * Characters PER PAGE can: a scan yields roughly zero however many pages it
 * has, while any page with real text on it clears this bar easily.
 */
const MIN_CHARS_PER_PAGE = 8;

export type PdfResult =
  { ok: true; text: string; pages: number } | { ok: false; reason: 'unreadable' | 'no-text-layer' };

export async function extractPdfText(bytes: Uint8Array): Promise<PdfResult> {
  let text: string;
  let pages: number;

  try {
    const result = await extractText(bytes, { mergePages: true });
    text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text;
    pages = typeof result.totalPages === 'number' ? result.totalPages : 1;
  } catch {
    // Encrypted or malformed files throw rather than returning nothing.
    return { ok: false, reason: 'unreadable' };
  }

  const trimmed = text.trim();
  const perPage = trimmed.length / Math.max(pages, 1);
  if (perPage < MIN_CHARS_PER_PAGE) {
    return { ok: false, reason: 'no-text-layer' };
  }

  return { ok: true, text: trimmed, pages };
}
