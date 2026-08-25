import type {
  Announcement,
  Assignment,
  Attachment,
  CourseMaterial,
  SubmissionSummary,
  Topic,
} from '../tools/google/classroom.js';
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
 * Announcements and materials carry words a teacher wrote, and were left out
 * of the first version because there was nowhere safe to put them. That is no
 * longer true: a note records its source, and anything whose source is not the
 * student is rendered inside the same warning the tools use. So they are here
 * -- and on a real account they were more than half of everything Classroom
 * held, which is the difference between a vault that knows a course exists and
 * one that knows what happened in it.
 */

export interface ClassroomSnapshot {
  courses: { id: string; name: string }[];
  coursework: Assignment[];
  topics: Topic[];
  submissions: SubmissionSummary[];
  announcements: Announcement[];
  materials: CourseMaterial[];
}

export interface ImportResult {
  written: number;
  updated: number;
}

/**
 * How Classroom names a per-student template master.
 *
 * A string match, which is the only signal the API offers -- there is no flag
 * on the material saying it is a template. If a school's Classroom is in
 * another language this will not match, and those files simply fall through to
 * being imported and found unreadable, which is where they were before.
 */
const TEMPLATE_PREFIX = '[Template]';

/** `Due: <date>` in a note body, so a moved deadline can be noticed. */
const DUE_LINE = /^Due: (.+)$/m;

/**
 * A stable identity, falling back to what the thing is when the id is missing.
 *
 * Every note is stored under its external id, so two notes sharing one id are
 * one file. Classroom always sends ids -- but a field nobody looks at going
 * empty would silently collapse a term of announcements into whichever arrived
 * last, and losing them quietly is worse than a duplicate.
 */
function identify(id: string, fallback: string): string {
  return id || fallback;
}

export async function importClassroom(
  vault: Vault,
  snapshot: ClassroomSnapshot,
): Promise<ImportResult> {
  /*
   * Episodes are listed too, not just entities.
   *
   * Announcements land as episodes, and a name is only free if nothing of
   * either kind has it -- two notes with one name are one file.
   */
  const [existing, existingEpisodes] = await Promise.all([
    vault.list('entity'),
    vault.list('episode'),
  ]);
  const byExternalId = new Map(
    [...existing, ...existingEpisodes].filter((n) => n.externalId).map((n) => [n.externalId, n]),
  );
  const takenNames = new Set([...existing, ...existingEpisodes].map((n) => n.name));

  const result: ImportResult = { written: 0, updated: 0 };

  /**
   * A note for each Drive file a teacher attached, and links back to it.
   *
   * These were being written into the parent's body as `Attached: <title>` --
   * dead text naming something nothing could open, link to, or find again. The
   * id has always been there, so this costs no model call and is the whole
   * difference between knowing a reading exists and knowing which assignment
   * it belongs to.
   *
   * Only files. A YouTube link or a form is a URL, and a note for one would be
   * a title with nothing behind it -- the agent cannot open it later, so it
   * stays a line in the parent instead of becoming a node.
   */
  const attach = async (
    attachments: Attachment[] | undefined,
    courseName: string,
    parent: string,
    /*
     * How the file relates to the note it came from, in the file's own words.
     *
     * A worksheet a teacher posted and the copy a student handed in are both
     * "attached" to the same assignment and are not the same thing at all --
     * and which one it is, is exactly what somebody asking "what did I write
     * for this" needs to know.
     */
    relation = 'Attached to',
  ): Promise<string[]> => {
    const lines: string[] = [];
    for (const item of attachments ?? []) {
      /*
       * The master behind "make a copy for each student", which Classroom
       * names this way and never shares with the student.
       *
       * A note for one is a dead end three times over: it can never be read,
       * its link opens nothing, and Drive answers it with the same "not
       * found" as a genuinely missing file -- so it would be retried on every
       * refresh for the rest of the year. There were 36 on a real account.
       * What the student actually worked on arrives on their submission.
       */
      if (item.title.startsWith(TEMPLATE_PREFIX)) continue;

      if (item.kind !== 'file' || !item.fileId) {
        lines.push(`Attached: ${item.title}`);
        continue;
      }

      const name = nameFor(item.fileId, item.title);
      await save({
        name,
        kind: 'entity',
        source: 'classroom',
        description: 'File',
        externalId: item.fileId,
        ...(item.url ? { sourceUrl: item.url } : {}),
        body: [`${item.title}.`, '', linkToCourse(courseName), `${relation} [[${parent}]].`].join(
          '\n',
        ),
      });
      lines.push(`Attached: [[${name}]]`);
    }
    return lines;
  };

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

  /*
   * Who owns which part of a note's body.
   *
   * The importer owns everything above the first `## ` heading -- the title,
   * the links, the due date, the state -- and rebuilds it from Classroom every
   * run. Everything from that heading down was put there by another pass and
   * is none of its business.
   *
   * Without this a re-import silently destroyed work. Observed on a real
   * vault: 723 files carried a summary of their own contents, an import ran,
   * and 127 were left. Six hundred model calls that had already been paid for,
   * gone, and nothing reported it -- from the importer's side it was just an
   * update.
   */
  const OWNED_BY_OTHERS = /^## /m;

  const save = async (note: VaultNote): Promise<void> => {
    const before = byExternalId.get(note.externalId);

    const appended = before ? OWNED_BY_OTHERS.exec(before.body) : null;
    const kept = appended ? `\n\n${before!.body.slice(appended.index).trimEnd()}` : '';
    const merged: VaultNote = kept ? { ...note, body: `${note.body.trimEnd()}${kept}` } : note;

    if (before && before.body === merged.body && before.description === merged.description) return;

    await vault.write(merged);
    byExternalId.set(merged.externalId, merged);
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

  // --- Topics first: coursework links to them, so they must exist to link to. ---
  const topicNote = new Map<string, string>();
  for (const topic of snapshot.topics) {
    const name = nameFor(topic.topicId, topic.name);
    topicNote.set(topic.topicId, name);

    await save({
      name,
      kind: 'entity',
      source: 'classroom',
      description: 'Topic',
      externalId: topic.topicId,
      body: `${topic.name}.\n\n${linkToCourse(topic.course)}`,
    });
  }

  // --- Coursework, with whatever is known about submitting it. ---
  const submissionFor = new Map(snapshot.submissions.map((s) => [s.courseWorkId, s]));

  for (const work of snapshot.coursework) {
    const name = nameFor(work.id, work.title);
    const previous = byExternalId.get(work.id);

    const lines = [`${work.title}.`, '', linkToCourse(work.course)];

    // The unit it belongs to, when the teacher filed it under one. Without
    // this every topic note has no inbound link and is dead weight.
    const topic = work.topicId ? topicNote.get(work.topicId) : undefined;
    if (topic) lines.push(`Part of [[${topic}]].`);
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
      /*
       * The tool has already turned Classroom's enum into words -- "turned in",
       * "not turned in", "graded and returned" -- so this capitalises whatever
       * arrives rather than matching one value. Matching TURNED_IN looked right
       * and would have silently taken the fallback path on every real account.
       */
      const state = submission.state.charAt(0).toUpperCase() + submission.state.slice(1);
      const late = submission.late ? ', late' : '';
      const grade =
        submission.grade === null
          ? ''
          : `. Marked ${submission.grade}${submission.maxPoints === null ? '' : `/${submission.maxPoints}`}`;
      lines.push(`${state}${late}${grade}.`);

      /*
       * What the student actually handed in.
       *
       * Their own copy, under their own id, which they can open and we can
       * read -- unlike the "[Template]" master attached to the assignment,
       * which Classroom never shares with them. This is the only place in the
       * vault that holds the student's own schoolwork rather than the
       * school's.
       */
      const mine = await attach(
        submission.attachments,
        work.course,
        name,
        'You handed in this for',
      );
      if (mine.length > 0) {
        lines.push('', ...mine.map((entry) => entry.replace('Attached:', 'You handed in:')));
      }
    }

    const attached = await attach(work.attachments, work.course, name);
    if (attached.length > 0) lines.push('', ...attached);

    await save({
      name,
      kind: 'entity',
      source: 'classroom',
      description: 'Assignment',
      externalId: work.id,
      body: lines.join('\n'),
    });
  }

  // --- Materials: a reading or a slide deck, which sits there all term. ---
  for (const material of snapshot.materials) {
    const id = identify(material.id, `${material.course}:${material.title}`);
    const name = nameFor(id, material.title);
    const lines = [`${material.title}.`, '', linkToCourse(material.course)];
    if (material.description) lines.push('', material.description);
    const attached = await attach(material.attachments, material.course, name);
    if (attached.length > 0) lines.push('', ...attached);

    await save({
      name,
      kind: 'entity',
      source: 'classroom',
      description: 'Material',
      externalId: id,
      ...(material.link ? { sourceUrl: material.link } : {}),
      body: lines.join('\n'),
    });
  }

  /*
   * --- Announcements: the one thing here that is an event. ---
   *
   * A course and an assignment are things that persist; a teacher saying
   * "no class Thursday" happened at a moment and is only meaningful with that
   * moment attached. So these are episodes, and they are what gives the
   * quieter parts of the year anything on the timeline at all.
   */
  for (const announcement of snapshot.announcements) {
    // Named from its own opening words rather than a number, so a person
    // reading a list of filenames can tell them apart.
    const opening = announcement.text.trim().split(/\s+/).slice(0, 8).join(' ');
    const name = nameFor(
      identify(announcement.id, `${announcement.course}:${announcement.postedAt ?? opening}`),
      opening || `announcement in ${announcement.course}`,
    );

    const lines = [
      linkToCourse(announcement.course).replace('Part of', 'In'),
      '',
      announcement.text,
    ];
    const attached = await attach(announcement.attachments, announcement.course, name);
    if (attached.length > 0) lines.push('', ...attached);

    await save({
      name,
      kind: 'episode',
      source: 'classroom',
      description: `Announcement in ${announcement.course}`,
      event: 'announcement',
      externalId: identify(
        announcement.id,
        `${announcement.course}:${announcement.postedAt ?? opening}`,
      ),
      ...(announcement.postedAt ? { occurred: new Date(announcement.postedAt).toISOString() } : {}),
      ...(announcement.link ? { sourceUrl: announcement.link } : {}),
      body: lines.join('\n'),
    });
  }

  return result;
}
