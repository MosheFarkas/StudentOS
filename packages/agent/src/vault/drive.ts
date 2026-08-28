import { courseForFolder } from './collapse.js';
import { slugForNote } from './slug.js';
import type { Vault } from './vault.js';

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
  /** Files Classroom already gave us, which know more than Drive does. */
  skipped: number;
}

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

export async function importDrive(vault: Vault, files: DriveFile[]): Promise<DriveImportResult> {
  const existing = await vault.list('entity');
  const known = new Set(existing.map((note) => note.externalId).filter(Boolean));
  const takenNames = new Set(existing.map((note) => note.name));

  /*
   * The courses still in the vault, by the title the school gave them.
   *
   * By title rather than by note name, because a folder is matched on the words
   * that say what a subject is -- and the title is where those words are
   * written the way a person writes them.
   */
  const courses = new Map(
    existing
      .filter((note) => note.description === 'Course')
      .map((note) => [(note.body.split('\n')[0] ?? '').split(', on Google')[0] ?? '', note.name]),
  );

  const result: DriveImportResult = { written: 0, skipped: 0 };

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
    if (known.has(file.fileId)) {
      result.skipped += 1;
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
    known.add(file.fileId);

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
    const course = (file.path ?? [])
      .map((folder) => courseForFolder(folder, courses))
      .find(Boolean);

    /*
     * And a file that belongs to no course they take does not come in.
     *
     * Left out rather than brought in and swept afterwards, because reading one
     * is a model call: importing and then removing pays that on every build for
     * ever, for a file nobody wanted kept. The same reason last year's courses
     * are filtered before the import rather than after it.
     *
     * It costs the personal half of a Drive -- music, photographs, an
     * application to another school -- which is a real loss and a deliberate
     * one. A vault is what an agent reads about somebody's schooling, and a
     * thousand files it can say nothing about are a thousand ways for a search
     * to answer with the wrong thing.
     */
    if (!course) {
      result.skipped += 1;
      continue;
    }

    lines.push(`Part of [[${course}]].`);

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
