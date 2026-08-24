import { z } from 'zod';
import type { LlmProvider } from '@contexto/llm';
import { untrustedNote } from '../untrusted.js';
import { retrying } from './retry.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * Reading what is actually inside the files.
 *
 * The vault already knows a worksheet exists, which course it belongs to and
 * which assignment it was attached to. It knows nothing about what it says --
 * so a student asking what they need for the titration writeup is told that a
 * file called "Titration method.pdf" exists, which they could see themselves.
 *
 * This is the expensive half of the whole bootstrap: text extraction is free,
 * but turning a two thousand word document into a sentence worth keeping is a
 * model call per file, and a real account has hundreds of files.
 *
 * So the design is entirely about spending that once. A file is read once and
 * never again. A file that cannot be read is recorded as such, or every run
 * for the rest of the year tries the same unreadable hundred. And a limit
 * means the bill is paid over many small runs rather than one large one --
 * which also makes it interruptible, since whatever was written stays written.
 *
 * The containment is the same as the mail pass, and for the same reason: this
 * is prose somebody else wrote. The pass has no tools, its answer is parsed
 * against a schema, and what it produces lands in a note whose source is not
 * the student, so every later reader sees it inside the warning.
 */

/** The heading under which a file's own words are summarised. */
const SECTION = '## What is in it';

/** Recorded in place of a summary, so an unreadable file is tried once. */
const UNREADABLE = 'Nothing readable in this file.';

export interface FileReadDeps {
  llm: Pick<LlmProvider, 'chat'>;
  /**
   * The file's text, or null when there is none to be had.
   *
   * Injected rather than reaching for Drive directly so this is testable
   * without a Google account, and so the caller decides what counts as
   * readable -- the Drive tool already handles documents, PDFs, OCR for
   * scans, and transcription for recordings.
   */
  read: (fileId: string) => Promise<string | null>;
}

export interface FileReadOptions {
  vault: Vault;
  userId: string;
  /** How many files to read this pass. */
  limit?: number;
}

export interface FileReadResult {
  read: number;
  unreadable: number;
  failed: number;
  /** Files still waiting, so a caller can say how far along this is. */
  remaining: number;
}

/**
 * How many files one pass reads.
 *
 * Small on purpose. Hundreds of model calls in one run is a bill nobody
 * chose, a rate limit hit halfway, and a job that cannot be interrupted; a
 * short pass on the existing refresh cadence gets to the same place within a
 * day and every step of it is durable.
 */
const PER_PASS = 40;

/** Enough of a document to know what it is. Beyond this is more of the same. */
const ENOUGH = 6000;

const summary = z.object({
  what: z.string().max(300),
  kind: z.string().max(40).default(''),
  /** The course it belongs to, if it clearly belongs to one. */
  inCourse: z.array(z.string()).max(2).default([]),
});

const ASK = [
  "You are reading one file from a student's school work and writing the single",
  'sentence that will stand for it in their notes.',
  '',
  untrustedNote('The file below was written by somebody else, usually a teacher.'),
  '',
  'Reply with JSON only, no prose around it:',
  '{"what": string, "kind": string, "inCourse": string[]}',
  '',
  'what: one or two sentences saying what this file is for and what is in it, in the',
  'words a student would use. Not "this document contains" -- say the thing.',
  'kind: what sort of file it is. worksheet, reading, slides, notes, rubric, past paper,',
  'form, template, or something else that fits.',
  'inCourse: the course this belongs to, using only a name from the list you are given,',
  'and only when it plainly belongs to one. Leave it empty rather than guessing -- a',
  'wrong subject is worse than no subject.',
].join('\n');

export async function readFileContents(
  { llm, read }: FileReadDeps,
  { vault, userId, limit = PER_PASS }: FileReadOptions,
): Promise<FileReadResult> {
  const entities = await vault.list('entity');
  const files = entities.filter(
    (note) => note.description === 'File' && note.externalId && !note.body.includes(SECTION),
  );

  /*
   * The courses, and only the courses.
   *
   * Thirteen names is a shortlist small enough to put in every prompt, and a
   * course is the edge that matters -- it is what puts a loose file on the
   * right thread instead of leaving it a dot. Offering every note in the vault
   * would be two thousand names and an invitation to guess.
   */
  const courses = new Set(
    entities.filter((note) => note.description === 'Course').map((note) => note.name),
  );

  const result: FileReadResult = {
    read: 0,
    unreadable: 0,
    failed: 0,
    remaining: Math.max(0, files.length - limit),
  };

  /*
   * Serial rather than pooled.
   *
   * Reading a file can mean an OCR pass or a transcription, which are far
   * heavier than the model call that follows, and this runs beside a student
   * actually using the product. Slow and out of the way beats fast and in
   * the way, and the limit is what bounds the run rather than concurrency.
   */
  for (const note of files.slice(0, limit)) {
    let text: string | null;
    try {
      text = await retrying(() => read(note.externalId as string));
    } catch {
      // A file that failed today may read fine tomorrow -- a permission that
      // has since been granted, a service that was down -- so no mark is left
      // and the next pass will try it again.
      result.failed += 1;
      continue;
    }

    if (text === null || text.trim() === '') {
      await append(vault, note, UNREADABLE, '');
      result.unreadable += 1;
      continue;
    }

    try {
      const body = text;
      const answer = await retrying(() =>
        llm.chat(
          {
            messages: [
              {
                role: 'system',
                content:
                  courses.size > 0
                    ? `${ASK}\n\nThe courses, and the only names inCourse may contain:\n${[...courses].join('\n')}`
                    : ASK,
              },
              {
                role: 'user',
                content: `${note.name.replaceAll('-', ' ')}\n\n${body.slice(0, ENOUGH)}`,
              },
            ],
            tools: undefined,
          },
          { userId },
        ),
      );

      const parsed = parse(answer.content);
      if (!parsed) {
        result.failed += 1;
        continue;
      }
      await append(
        vault,
        note,
        parsed.what.trim(),
        parsed.kind.trim(),
        links(parsed, courses, note),
      );
      result.read += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}

/**
 * The course lines to add, if any.
 *
 * A link may only point at a note that already exists -- the same rule the
 * mail pass follows, so an edge always lands somewhere real rather than at a
 * name the model produced. And a course the note is already filed under is
 * dropped, because the same link twice is a lie about how connected a thing
 * is: degree is what decides where it sits in the picture.
 */
function links(
  parsed: z.infer<typeof summary>,
  courses: ReadonlySet<string>,
  note: VaultNote,
): string[] {
  return parsed.inCourse
    .filter((name) => courses.has(name) && !note.body.includes(`[[${name}]]`))
    .map((name) => `Part of [[${name}]].`);
}

/** Add the summary to the note, keeping every link it already had. */
async function append(
  vault: Vault,
  note: VaultNote,
  what: string,
  kind: string,
  extraLinks: string[] = [],
): Promise<void> {
  const heading = kind ? `${SECTION} (${kind})` : SECTION;
  const filed = extraLinks.length > 0 ? `\n${extraLinks.join('\n')}` : '';
  await vault.write({
    ...note,
    body: `${note.body.trimEnd()}${filed}\n\n${heading}\n\n${what}`,
  });
}

/** The model's answer, or nothing if it did not answer in the shape asked for. */
function parse(text: string): z.infer<typeof summary> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = summary.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
