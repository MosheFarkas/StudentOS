import { createHash } from 'node:crypto';
import type { LlmProvider } from '@contexto/llm';
import { extractPdfText } from '../tools/pdf.js';
import { describeImage, isReadableImage } from './image-doc.js';
import { extractOfficeText, officeKindFor } from './office.js';
import { slugForNote } from './slug.js';
import type { Vault } from './vault.js';

/**
 * A file the student handed over from their own machine.
 *
 * It goes into the vault rather than into the message, and that is the whole
 * design. A message is read once by one conversation; the vault is the only
 * memory that outlives one. A syllabus uploaded in September is still there in
 * March, and every chat can find it -- which is the same reason chats.md lives
 * here and not on an agent.
 *
 * It also means there is no plumbing to get the file into the turn. The
 * message names what was attached, the agent opens it by name, and that is the
 * path it already uses for everything else in the vault.
 */

/**
 * The most we will read.
 *
 * Not a storage limit -- the file is never stored, only its text. It is a
 * bound on what one upload can cost to extract and, further downstream, on
 * what can be pulled into a prompt in one go.
 */
export const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

/** Why an upload was turned away, in terms a student can act on. */
export type UploadRefusal =
  | 'too-large'
  | 'unsupported-type'
  | 'empty'
  /** A PDF that is images of text: real content, no text layer, needs OCR. */
  | 'no-text-layer'
  | 'unreadable'
  /** A format no model will look at -- HEIC above all, which iPhones default to. */
  | 'image-format'
  /** Vision is not configured on this deployment, so pictures cannot be read. */
  | 'no-vision'
  /** A document that opened but held no words at all. */
  | 'nothing-in-it';

export type UploadResult = { ok: true; name: string } | { ok: false; reason: UploadRefusal };

export interface IncomingFile {
  filename: string;
  /** As the browser reported it, which is sometimes not at all. */
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * `sniff` means "decide by looking inside".
 *
 * The extension is a guess about a file, and a poor one: a syllabus saved as
 * .text, a timetable exported as .tsv and a source file with no extension at
 * all are every bit as readable as a .txt. So anything not recognised on sight
 * is opened and judged on what is in it.
 */
type Classification =
  | { kind: 'pdf' | 'text' | 'sniff' | 'image' }
  | { kind: 'office'; office: ReturnType<typeof officeKindFor> }
  | { refusal: UploadRefusal };

/** Recognised on sight, so the common cases never reach the sniffer. */
const TEXT_PREFIX = 'text/';
const TEXT_TYPES = ['application/json', 'application/xml', 'application/javascript'];
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.rtf'];

/** Real content, none of it text. Worth its own sentence to a student. */
const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.heif',
  '.bmp',
  '.tiff',
  '.svg',
];

/**
 * Apple's own formats, which are zips but not the ones office.ts reads.
 *
 * Kept separate from the office list so the refusal can say the useful thing
 * -- Pages and Keynote export to Word, PowerPoint and PDF from the share menu
 * -- rather than a flat "cannot read this".
 */
const APPLE_EXTENSIONS = ['.pages', '.key', '.numbers'];

/**
 * What this file is, as far as its name and type can say.
 *
 * Size is checked here rather than after extraction so a 200MB file costs a
 * rejection rather than a parse. The type is taken from the browser when it
 * sent one and from the extension when it did not, because a drag-and-drop
 * from some file managers arrives with an empty type -- and when neither
 * settles it, the answer is `sniff` and the bytes decide.
 */
export function classifyUpload(file: {
  filename: string;
  mimeType: string;
  size: number;
}): Classification {
  if (file.size === 0) return { refusal: 'empty' };
  if (file.size > UPLOAD_LIMIT_BYTES) return { refusal: 'too-large' };

  const name = file.filename.toLowerCase();
  const type = file.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const ends = (list: string[]) => list.some((ext) => name.endsWith(ext));

  if (type === 'application/pdf' || name.endsWith('.pdf')) return { kind: 'pdf' };

  if (type.startsWith('image/') || ends(IMAGE_EXTENSIONS)) {
    return isReadableImage(file.mimeType, file.filename)
      ? { kind: 'image' }
      : { refusal: 'image-format' };
  }

  const office = officeKindFor(file.filename, file.mimeType);
  if (office) return { kind: 'office', office };
  if (ends(APPLE_EXTENSIONS)) return { refusal: 'unsupported-type' };
  if (type.startsWith(TEXT_PREFIX) || TEXT_TYPES.includes(type) || ends(TEXT_EXTENSIONS)) {
    return { kind: 'text' };
  }

  return { kind: 'sniff' };
}

/**
 * Whether these bytes are text a person could read.
 *
 * Decoded strictly first: UTF-8 that fails to decode is binary, and that one
 * check removes most of what should never have been sent. What survives is
 * judged on control characters, because a file can decode cleanly and still be
 * a stream of bytes -- a NUL byte in particular appears in no text file and in
 * most binary ones.
 *
 * The threshold is deliberately loose rather than zero. Real text files carry
 * the odd stray control character -- a form feed in something printed, a
 * vertical tab in an export -- and refusing a whole syllabus over one byte
 * would be the wrong way to be strict.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }

  if (text.trim() === '') return false;

  let control = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    // Tab, newline and carriage return are text; the rest of C0 is not.
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) control += 1;
  }

  return control / text.length < 0.01;
}

/**
 * The note name an upload takes.
 *
 * The filename without its extension, slugged -- so "Biology Syllabus.pdf"
 * becomes `biology-syllabus`. Deriving it from the name rather than from a
 * random id is what makes a second upload of the same file replace the first
 * instead of piling up beside it, and what lets the agent find a note the
 * student refers to by the name they know it by.
 *
 * slugForNote is what makes this safe to join onto a path; the name arrives
 * from a browser and may be anything at all.
 */
export function uploadNoteName(filename: string): string {
  return slugForNote(filename.replace(/\.[^./\\]+$/, ''));
}

/**
 * What the reader needs beyond the file itself.
 *
 * Only pictures need anything: turning one into words takes a model, and a
 * deployment without one should refuse them clearly rather than fail oddly.
 */
export interface UploadDeps {
  llm?: Pick<LlmProvider, 'chat'>;
  userId?: string;
}

/** Read the file's text, or say why there is none to read. */
async function textOf(
  file: IncomingFile,
  classified: Exclude<Classification, { refusal: UploadRefusal }>,
  deps: UploadDeps,
): Promise<UploadResult | string> {
  if (classified.kind === 'pdf') {
    const extracted = await extractPdfText(file.bytes);
    return extracted.ok ? extracted.text : { ok: false, reason: extracted.reason };
  }

  if (classified.kind === 'office') {
    const text = classified.office && extractOfficeText(file.bytes, classified.office);
    return text ?? { ok: false, reason: 'nothing-in-it' };
  }

  if (classified.kind === 'image') {
    if (!deps.llm || !deps.userId) return { ok: false, reason: 'no-vision' };
    const described = await describeImage(deps.llm, file, deps.userId);
    return described ?? { ok: false, reason: 'nothing-in-it' };
  }

  if (classified.kind === 'sniff' && !looksLikeText(file.bytes)) {
    return { ok: false, reason: 'unsupported-type' };
  }

  return new TextDecoder().decode(file.bytes);
}

/**
 * Put an upload into the vault.
 *
 * Writes nothing when there is nothing worth writing. An empty note is worse
 * than a refusal: it is indistinguishable from a document that genuinely says
 * nothing, and the agent would go on citing it.
 */
export async function importUpload(
  vault: Vault,
  file: IncomingFile,
  deps: UploadDeps = {},
): Promise<UploadResult> {
  const classified = classifyUpload({
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.bytes.byteLength,
  });
  if ('refusal' in classified) return { ok: false, reason: classified.refusal };

  const text = await textOf(file, classified, deps);
  if (typeof text !== 'string') return text;

  const body = text.trim();
  if (body === '') return { ok: false, reason: 'empty' };

  const name = uploadNoteName(file.filename);
  await vault.write({
    name,
    kind: 'entity',
    // The source that already means "the student put this here themselves".
    source: 'student',
    description:
      classified.kind === 'image'
        ? `Read from a picture the student uploaded: ${file.filename}`
        : `Uploaded by the student: ${file.filename}`,
    /*
     * A fingerprint of the bytes, not of the name.
     *
     * The name is what decides which note gets replaced. This records which
     * file is in it, so a later pass can tell an unchanged re-upload from a
     * genuinely revised document without re-reading either.
     */
    externalId: createHash('sha256').update(file.bytes).digest('hex'),
    body,
  });

  return { ok: true, name };
}
