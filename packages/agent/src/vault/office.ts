import { unzipSync } from 'fflate';

/**
 * Word, PowerPoint, Excel, and their open-format cousins.
 *
 * One module reads all of them because they are all the same thing: a zip
 * archive with XML inside. What differs between a .docx and a .pptx is which
 * entry holds the words and which tag they sit in -- not the container, not
 * the parsing, and not the failure modes.
 *
 * The XML is read with expressions rather than a parser, which is usually the
 * wrong instinct and is right here. These are not documents in the open-ended
 * sense; they are machine-written files with a fixed shape, and what is wanted
 * from them is the contents of one tag. A parser would add a dependency and a
 * tree walk to reach the same strings.
 *
 * Google Docs and Slides need no special case: Drive exports them as .docx and
 * .pptx, so a student downloading one and handing it over lands here. The
 * agent also reads Google-native files directly through its Drive tools, which
 * is the other half of the same coverage.
 */

export type OfficeKind = 'docx' | 'pptx' | 'xlsx' | 'odf';

const BY_EXTENSION: [string, OfficeKind][] = [
  ['.docx', 'docx'],
  ['.pptx', 'pptx'],
  ['.xlsx', 'xlsx'],
  ['.odt', 'odf'],
  ['.odp', 'odf'],
  ['.ods', 'odf'],
];

const BY_TYPE: [string, OfficeKind][] = [
  ['wordprocessingml.document', 'docx'],
  ['presentationml.presentation', 'pptx'],
  ['spreadsheetml.sheet', 'xlsx'],
  ['opendocument.text', 'odf'],
  ['opendocument.presentation', 'odf'],
  ['opendocument.spreadsheet', 'odf'],
];

/** Which of them this is, if it is one at all. */
export function officeKindFor(filename: string, mimeType: string): OfficeKind | null {
  const name = filename.toLowerCase();
  const type = mimeType.toLowerCase();

  for (const [extension, kind] of BY_EXTENSION) if (name.endsWith(extension)) return kind;
  // The name is the better signal and comes first: a browser that sends no
  // type is common, one that sends a wrong extension is not.
  for (const [fragment, kind] of BY_TYPE) if (type.includes(fragment)) return kind;
  return null;
}

/**
 * The words in it, or null when there are none to be had.
 *
 * Null covers three different situations on purpose -- not a zip, a zip
 * without the part we need, and a document that genuinely says nothing. The
 * caller turns them into one refusal, because a student can do the same thing
 * about all three: send it as a PDF instead.
 */
export function extractOfficeText(bytes: Uint8Array, kind: OfficeKind): string | null {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    // Not a zip, or a damaged one. Either way there is nothing inside to read.
    return null;
  }

  const text = readEntries(entries, kind).trim();
  return text === '' ? null : text;
}

function readEntries(entries: Record<string, Uint8Array>, kind: OfficeKind): string {
  const decode = (name: string) => {
    const found = entries[name];
    return found ? new TextDecoder().decode(found) : '';
  };

  switch (kind) {
    case 'docx':
      // One line per <w:p>, runs inside it joined -- a paragraph is a line and
      // a run is a formatting boundary, not a break.
      return paragraphs(decode('word/document.xml'), 'w:p', 'w:t');

    case 'pptx':
      return slidesOf(entries)
        .map((name) => paragraphs(decode(name), 'a:p', 'a:t'))
        .filter((slide) => slide !== '')
        .join('\n');

    case 'xlsx':
      /*
       * The shared string table, which is where a spreadsheet keeps its words.
       *
       * Cells hold numbers and references into this table, so the table alone
       * carries every label, heading and note in the file. What it loses is
       * which cell said what -- worth knowing, and not worth a full sheet
       * parse for the sake of a document a student wants read back to them.
       */
      return paragraphs(decode('xl/sharedStrings.xml'), 'si', 't');

    case 'odf':
      return paragraphs(decode('content.xml'), 'text:p', null);
  }
}

/** The slide parts, in the order a person would read them. */
function slidesOf(entries: Record<string, Uint8Array>): string[] {
  return Object.keys(entries)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
}

/**
 * Numerically, not as a string.
 *
 * "slide10" sorts before "slide2" alphabetically, which silently shuffles
 * every deck longer than nine slides.
 */
function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

/**
 * One line per block, with the pieces inside each block joined up.
 *
 * `inner` is the tag holding the actual characters; pass null where the block
 * has no such tag and everything inside it is text, which is how the open
 * formats are written.
 */
function paragraphs(xml: string, block: string, inner: string | null): string {
  if (xml === '') return '';

  const blocks = matchAll(xml, new RegExp(`<${block}(?:\\s[^>]*)?>([\\s\\S]*?)</${block}>`, 'g'));
  return blocks
    .map((body) => (inner === null ? stripTags(body) : matchAll(body, tagPattern(inner)).join('')))
    .map((line) =>
      unescapeXml(line)
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .filter((line) => line !== '')
    .join('\n');
}

function tagPattern(tag: string): RegExp {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '');
}

function stripTags(xml: string): string {
  return xml.replace(/<[^>]*>/g, '');
}

/**
 * The five entities XML defines, and numeric escapes.
 *
 * `&amp;` is unescaped last. Doing it first would turn `&amp;lt;` -- a
 * document that literally says "&lt;" -- into a tag.
 */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}
