import { courseForFolder } from './collapse.js';
import { slugForNote } from './slug.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * The student's own Drive, as notes.
 *
 * Different from the files a teacher attached in Classroom. Those arrive
 * already knowing their course and their assignment; these arrive knowing
 * almost nothing. Measured on a real account, 459 of 469 files resolved to no
 * folder at all -- the app has per-file Drive access rather than a view of the
 * tree, so the obvious way to file them carries nothing.
 *
 * What is left is the name, who owns it, and when it was last touched. That
 * turns out to be enough to be worth having: "ANSWERKEY June Exam Study Guide"
 * and "Liu and Rivard Gr10 Major Project" are the material a student actually
 * revises from. What each file is really about, and what it belongs to, is
 * settled afterwards by the pass that reads it -- which has to open the file
 * anyway, so the linking rides along at no extra cost.
 *
 * No model call happens here. This is a listing turned into notes.
 */

export interface DriveFile {
  fileId: string;
  name: string;
  mimeType: string;
  /** Whether the student owns it, rather than it being shared with them. */
  ownedByStudent: boolean;
  /**
   * Who owns it, when it is not the student.
   *
   * A worksheet shared into a course is owned by whoever shared it, which is
   * usually the person teaching it -- and unlike Classroom's opaque creator
   * ids, Drive returns a name and an address. The field mask never asked for
   * it, so a source of teacher names sat unread beside a thousand files.
   */
  owner?: string;
  modifiedAt?: string;
  link?: string;
  /** Folder names from the top down. Usually empty -- see above. */
  path?: string[];
}

export interface DriveImportResult {
  written: number;
  /** Files Classroom already gave us, and files nothing has judged in. */
  skipped: number;
  /** Files kept on an earlier pass and judged out on this one. */
  removed: number;
}

/**
 * What was decided about a file a folder did not place. See drive-triage.
 *
 * `course` is a note name, or null for a file that is about school without
 * being one course's -- a CAS project, an application, a club's plans.
 */
export interface DriveVerdict {
  keep: boolean;
  course: string | null;
}

/**
 * The line a kept file carries when it belongs to no course.
 *
 * The loose-file sweep takes any file that names no course and that nothing
 * points at. This is how a file judged in on its own account tells the sweep
 * it was wanted.
 */
export const KEPT_LOOSE = "About your schooling, though not one course's.";

const FOLDER = 'application/vnd.google-apps.folder';
export const SHORTCUT = 'application/vnd.google-apps.shortcut';

/**
 * The courses still in the vault, by the title the school gave them.
 *
 * By title rather than by note name, because a folder is matched on the words
 * that say what a subject is -- and the title is where those words are
 * written the way a person writes them. The triage shows the same titles to
 * its model, and links back through the same map.
 */
export function courseTitles(existing: readonly VaultNote[]): Map<string, string> {
  return new Map(
    existing
      .filter((note) => note.description === 'Course')
      .map((note) => [(note.body.split('\n')[0] ?? '').split(', on Google')[0] ?? '', note.name]),
  );
}

export async function importDrive(
  vault: Vault,
  files: DriveFile[],
  judged: ReadonlyMap<string, DriveVerdict> = new Map(),
): Promise<DriveImportResult> {
  const existing = await vault.list('entity');
  const held = new Map(existing.filter((note) => note.externalId).map((n) => [n.externalId, n]));
  const takenNames = new Set(existing.map((note) => note.name));
  const courses = courseTitles(existing);

  const result: DriveImportResult = { written: 0, skipped: 0, removed: 0 };

  for (const file of files) {
    // A folder is structure rather than content, and a shortcut is a second
    // name for something already here.
    if (file.mimeType === FOLDER || file.mimeType === SHORTCUT) continue;

    /*
     * Classroom knows more about this file than Drive does.
     *
     * 139 of this account's files are both. The Classroom note already carries
     * the course and the assignment it was attached to, and rewriting it from
     * a Drive listing would trade all of that for a filename.
     */
    const already = held.get(file.fileId);
    if (already) {
      /*
       * And a file kept on an earlier pass goes when it is judged out now.
       *
       * The rule can change its mind -- last year's science slides were kept
       * on their name, opened, and only then known for what they were -- and a
       * refusal that never reaches the note on disk changes nothing. Only what
       * Drive brought in: a file Classroom attached is Classroom's to remove.
       */
      if (already.source === 'drive' && judged.get(file.fileId)?.keep === false) {
        if (await vault.remove('entity', already.name)) result.removed += 1;
      } else result.skipped += 1;
      continue;
    }

    let name = slugForNote(file.name);
    if (takenNames.has(name)) {
      // Students copy files, and "Copy of Copy of June Exam Study Guide" slugs
      // to the same name as the one before it.
      let suffix = 2;
      while (takenNames.has(`${name}-${suffix}`)) suffix += 1;
      name = `${name}-${suffix}`;
    }
    takenNames.add(name);
    held.set(file.fileId, { name, source: 'drive' } as VaultNote);

    const lines = [`${file.name}.`, ''];

    /*
     * Which course this belongs to, from the folder it sits in.
     *
     * Matched on the words that say what a subject is rather than on the names
     * as written: a folder called "DESIGN 10" and a course called "GR10 -
     * Design // 2025-26" are one subject said twice, and comparing them
     * literally left five hundred files of design coursework belonging to
     * nothing at all.
     */
    const filed = (file.path ?? []).map((folder) => courseForFolder(folder, courses)).find(Boolean);

    /*
     * And what no folder places is in only if it was judged in.
     *
     * Every other file in a Drive is put in front of a model on its listing
     * -- see drive-triage -- and arrives here with a verdict, or without one
     * because nothing has judged it yet. Silence is not an answer: a file with
     * no verdict waits for the next refresh rather than coming in or being
     * refused on nothing.
     *
     * Left out rather than brought in and swept afterwards, because reading
     * one is a model call, and importing then removing pays that on every
     * build for ever. What is refused here is the personal half of a Drive --
     * photographs, music -- and that is the half a study agent has no use for.
     */
    const verdict = judged.get(file.fileId);
    if (!filed && !verdict?.keep) {
      result.skipped += 1;
      continue;
    }
    const course = filed ?? verdict?.course ?? null;

    if (course) lines.push(`Part of [[${course}]].`);
    else lines.push(KEPT_LOOSE);

    /*
     * And where it lives, which is more than the course alone says.
     *
     * "Design 10/Chair project/iterations" names the course and then says which
     * piece of work inside it, which is most of what there is to say about a
     * file called bracket.stl.
     */
    if (file.path && file.path.length > 0) lines.push(`Filed under ${file.path.join('/')}.`);

    /*
     * Whose file it is.
     *
     * The strongest signal left about whether a file matters to this student,
     * now that the folder tree turns out to be invisible -- and it decides
     * what gets read first when there are hundreds waiting.
     */
    if (file.ownedByStudent) lines.push('Yours -- you made this.');
    // Who shared it, when somebody else did. Usually whoever teaches the
    // course it was shared into, and one of the few places a name appears.
    else if (file.owner) lines.push(`Shared by ${file.owner}.`);
    if (file.modifiedAt) lines.push(`Last changed ${file.modifiedAt.slice(0, 10)}.`);

    await vault.write({
      name,
      kind: 'entity',
      source: 'drive',
      description: 'File',
      externalId: file.fileId,
      ...(file.link ? { sourceUrl: file.link } : {}),
      body: lines.join('\n').trim(),
    });
    result.written += 1;
  }

  return result;
}
