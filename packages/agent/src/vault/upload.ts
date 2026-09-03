import { createHash } from 'node:crypto';
import { extractPdfText } from '../tools/pdf.js';
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
  | 'unreadable';

export type UploadResult = { ok: true; name: string } | { ok: false; reason: UploadRefusal };

export interface IncomingFile {
  filename: string;
  /** As the browser reported it, which is sometimes not at all. */
  mimeType: string;
  bytes: Uint8Array;
}

type Classification = { kind: 'pdf' | 'text' } | { refusal: UploadRefusal };

const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.json'];

/**
 * What this file is, decided before any of it is read.
 *
 * Size is checked here rather than after extraction so a 200MB file costs a
 * rejection rather than a parse. The type is taken from the browser when it
 * sent one and from the extension when it did not, because a drag-and-drop
 * from some file managers arrives with an empty type.
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

  if (type === 'application/pdf' || name.endsWith('.pdf')) return { kind: 'pdf' };
  if (TEXT_TYPES.includes(type) || TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return { kind: 'text' };
  }

  return { refusal: 'unsupported-type' };
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

/** Read the file's text, or say why there is none to read. */
async function textOf(file: IncomingFile, kind: 'pdf' | 'text'): Promise<UploadResult | string> {
  if (kind === 'text') return new TextDecoder().decode(file.bytes);

  const extracted = await extractPdfText(file.bytes);
  return extracted.ok ? extracted.text : { ok: false, reason: extracted.reason };
}

/**
 * Put an upload into the vault.
 *
 * Writes nothing when there is nothing worth writing. An empty note is worse
 * than a refusal: it is indistinguishable from a document that genuinely says
 * nothing, and the agent would go on citing it.
 */
export async function importUpload(vault: Vault, file: IncomingFile): Promise<UploadResult> {
  const classified = classifyUpload({
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.bytes.byteLength,
  });
  if ('refusal' in classified) return { ok: false, reason: classified.refusal };

  const text = await textOf(file, classified.kind);
  if (typeof text !== 'string') return text;

  const body = text.trim();
  if (body === '') return { ok: false, reason: 'empty' };

  const name = uploadNoteName(file.filename);
  await vault.write({
    name,
    kind: 'entity',
    // The source that already means "the student put this here themselves".
    source: 'student',
    description: `Uploaded by the student: ${file.filename}`,
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
