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

/**
 * What may be decompressed, decided before anything is.
 *
 * The old check ran after unzipSync had already expanded the whole archive
 * into memory, which is the one moment it needed to act: it limited what was
 * kept, not what was allocated, so a real bomb would have taken the process
 * down before any check ran. fflate can be asked per entry instead, and the
 * declared uncompressed size sits in the archive's own index, so the decision
 * costs nothing and happens before the memory does.
 *
 * A bomb is one small entry claiming an enormous expansion, so the per-entry
 * limit is what actually catches one. The total is generous because a
 * hundred-megabyte kit of ordinary files is ordinary -- a robotics field
 * archive on a real account was exactly that -- and the old forty-megabyte
 * ceiling refused it.
 */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 2000;

/**
 * Extensions worth decompressing at all.
 *
 * A real robotics field kit was 93MB compressed and 236MB across 36 files,
 * and thirty of those were .obj, .fbx, .3mf, .dxf and .step -- geometry, which
 * holds coordinates and no words. Expanding them costs the memory and yields
 * nothing. The six PDFs beside them were the entire point of the archive.
 *
 * So the guard against a huge archive is not a bigger ceiling, it is opening
 * fewer of the files in it. Anything without an extension is admitted: a
 * README or a LICENSE is worth reading, and Office formats keep their XML
 * parts through the .xml entry here.
 */
const TEXT_BEARING = new Set([
  // Documents and data.
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'html',
  'htm',
  'rtf',
  'pdf',
  'docx',
  'doc',
  'pptx',
  'ppt',
  'odt',
  'odp',
  'ods',
  'rels',
  'log',
  'yml',
  'yaml',
  'srt',
  'vtt',
  'tex',
  'bib',
  /*
   * And source code, which is text and is coursework. A robotics archive is
   * as likely to hold the code that drives the robot as the drawings of it,
   * and a student asking what their program does deserves an answer.
   */
  'py',
  'js',
  'mjs',
  'ts',
  'tsx',
  'jsx',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'rb',
  'go',
  'rs',
  'swift',
  'kt',
  'php',
  'sh',
  'bash',
  'sql',
  'r',
  'ino',
  'm',
  'scm',
  'lisp',
  'lua',
  'pl',
  'toml',
  'ini',
  'cfg',
  'env',
]);

/** Whether an entry could hold words, judged from its name. */
function couldHoldText(path: string): boolean {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return extension === undefined || TEXT_BEARING.has(extension);
}

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
  let promised = 0;
  let refused = false;

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      /*
       * Decided from the archive's index, before a byte is decompressed.
       *
       * Returning false skips the entry entirely, so an entry that claims a
       * huge expansion never costs the memory it was asking for. Throwing
       * here would come back as a corrupt-archive error, so the refusal is
       * recorded and raised once the listing is done.
       */
      filter: (file) => {
        if (file.name.endsWith('/')) return false;
        // Geometry and media are skipped before they cost anything, rather
        // than decompressed and then found to contain no words.
        if (!couldHoldText(file.name)) return false;
        if (file.originalSize !== undefined && file.originalSize > MAX_ENTRY_BYTES) {
          refused = true;
          return false;
        }
        promised += file.originalSize ?? 0;
        if (promised > MAX_TOTAL_BYTES) {
          refused = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    throw new ArchiveError('That file is not a readable zip archive.');
  }

  if (refused) throw new ArchiveError('That archive is too large to open.');

  const entries: ArchiveEntry[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('/') || content.length === 0) continue;
    // A hard stop on count as well as bytes: ten thousand tiny files is its
    // own denial of service, in object churn rather than in memory.
    if (entries.length >= MAX_ENTRIES) break;
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
