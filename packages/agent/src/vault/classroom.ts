import type { Assignment, SubmissionSummary, Topic } from '../tools/google/classroom.js';
import { slugForNote } from './slug.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * Mapping Google Classroom into ContextoVault.
 *
 * The cheap half of the bootstrap. Courses, coursework, topics and submissions
 * arrive as objects carrying stable ids, so this is a data transformation with
 * no model in it -- deterministic, free, and testable without a network. The
 * expensive half is mail, where a model has to decide what matters, and that
 * comes after the trust boundary rather than before it.
 *
 * Nothing here reads prose a teacher wrote. Assignment descriptions and
 * announcements are deliberately left behind: until imported notes are
 * rendered inside the warning gmail.ts and portal.ts already use, none of that
 * belongs in a file the agent will eventually read.
 */

export interface ClassroomSnapshot {
  courses: { id: string; name: string }[];
  coursework: Assignment[];
  topics: Topic[];
  submissions: SubmissionSummary[];
}

export interface ImportResult {
  written: number;
  updated: number;
}

/** `Due: <date>` in a note body, so a moved deadline can be noticed. */
const DUE_LINE = /^Due: (.+)$/m;

export async function importClassroom(
  vault: Vault,
  snapshot: ClassroomSnapshot,
): Promise<ImportResult> {
  const existing = await vault.list('entity');
  const byExternalId = new Map(existing.filter((n) => n.externalId).map((n) => [n.externalId, n]));
  const takenNames = new Set(existing.map((n) => n.name));

  const result: ImportResult = { written: 0, updated: 0 };

  /**
   * The name a note will have, reusing the one it already has.
   *
   * An entity keeps whatever name it was first given, because the name is the
   * filename and the filename is what wikilinks point at. Renaming on every
   * title tweak would leave every link in the vault pointing at nothing.
   */
  const nameFor = (externalId: string, title: string): string => {
    const already = byExternalId.get(externalId);
    if (already) return already.name;

    let name = slugForNote(title);
    if (takenNames.has(name)) {
      /*
       * Two courses can share a name -- two sections of the same subject --
       * and the tool layer hands over the course name rather than its id for
       * coursework. Slugging alone would merge them into one note and lose a
       * course without saying so.
       */
      let suffix = 2;
      while (takenNames.has(`${name}-${suffix}`)) suffix += 1;
      name = `${name}-${suffix}`;
    }
    takenNames.add(name);
    return name;
  };

  const save = async (note: VaultNote): Promise<void> => {
    const before = byExternalId.get(note.externalId);
    if (before && before.body === note.body && before.description === note.description) return;

    await vault.write(note);
    byExternalId.set(note.externalId, note);
    if (before) result.updated += 1;
    else result.written += 1;
  };

  // --- Courses. Everything else links to one of these. ---
  const courseNameToNote = new Map<string, string>();
  for (const course of snapshot.courses) {
    const name = nameFor(course.id, course.name);
    // First course wins the plain name; a second of the same name still
    // resolves to itself, and coursework links to whichever came first.
    if (!courseNameToNote.has(course.name)) courseNameToNote.set(course.name, name);

    await save({
      name,
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      externalId: course.id,
      body: `${course.name}, on Google Classroom.`,
    });
  }

  const linkToCourse = (courseName: string): string => {
    const note = courseNameToNote.get(courseName);
    return note ? `Part of [[${note}]].` : `Part of ${courseName}.`;
  };

  // --- Coursework, with whatever is known about submitting it. ---
  const submissionFor = new Map(snapshot.submissions.map((s) => [s.courseWorkId, s]));

  for (const work of snapshot.coursework) {
    const name = nameFor(work.id, work.title);
    const previous = byExternalId.get(work.id);

    const lines = [`${work.title}.`, '', linkToCourse(work.course)];
    if (work.due) lines.push(`Due: ${work.due}`);

    /*
     * A deadline that moved is the thing Classroom cannot tell you.
     *
     * It shows the date as it is now; the fact that it used to be a week
     * earlier exists nowhere except in a copy that was taken before it moved.
     * Old values accumulate rather than replace, so the history survives.
     */
    const before = previous ? DUE_LINE.exec(previous.body)?.[1] : undefined;
    const history = previous
      ? previous.body
          .split('\n')
          .filter((line) => line.startsWith('Was due '))
          .join('\n')
      : '';
    if (history) lines.push(history);
    if (before && work.due && before !== work.due) lines.push(`Was due ${before}.`);

    const submission = submissionFor.get(work.id);
    if (submission) {
      const state = submission.state === 'TURNED_IN' ? 'Turned in' : submission.state;
      const late = submission.late ? ', late' : '';
      const grade =
        submission.grade === null
          ? ''
          : `. Marked ${submission.grade}${submission.maxPoints === null ? '' : `/${submission.maxPoints}`}`;
      lines.push(`${state}${late}${grade}.`);
    }

    await save({
      name,
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      externalId: work.id,
      body: lines.join('\n'),
    });
  }

  // --- Topics: what a course is made of. ---
  for (const topic of snapshot.topics) {
    await save({
      name: nameFor(topic.topicId, topic.name),
      kind: 'entity',
      source: 'classroom',
      description: 'Topic',
      externalId: topic.topicId,
      body: `${topic.name}.\n\n${linkToCourse(topic.course)}`,
    });
  }

  return result;
}
