import { z } from 'zod';
import type { LlmProvider } from '@contexto/llm';
import { untrustedNote } from '../untrusted.js';
import { slugForNote } from './slug.js';
import type { ClassroomSnapshot } from './classroom.js';
import { buildGraph } from './graph.js';
import { namesCourse } from './mail.js';
import { retrying } from './retry.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * Deciding which of a student's courses belong in their vault.
 *
 * A Classroom account accumulates. Nineteen courses on this account, six of
 * them last year's -- both Histories, Science and Technology, the IB Personal
 * Project -- and the vault imported every one of them because remembering last
 * year had been the point of a vault. It is not what a student means. Asked
 * about "my classes" they mean the six they walk to on Monday, and a search
 * that returns a chemistry worksheet from a course they finished in June is a
 * search that has failed.
 *
 * So courses are filtered rather than remembered, and the filter runs on every
 * build so that correcting it corrects every vault.
 *
 * Two questions, and only one of them is about age. A club, a house group or an
 * advisory room is not a class and does not end -- Model UN runs for as long as
 * a student turns up, and gets archived at the end of each year like everything
 * else. Judging those by age deletes half of a school life. So the model is
 * asked what a course *is* before anything asks how old it is, and only a real
 * academic class can be dropped for being over.
 *
 * It fails open. A pass that returns nothing usable keeps everything, because
 * keeping a finished course costs one stale document and dropping a live one
 * costs the student their year.
 */

export interface CourseClassifierDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface ClassifiableCourse {
  id: string;
  name: string;
  section?: string;
  /** ACTIVE or ARCHIVED, as the school has it. */
  courseState?: string;
  /**
   * The newest dated thing in this course, as an ISO date.
   *
   * The best answer to whether a course is over, and better than archiving:
   * a school that archives at the end of each semester archives a course a
   * student is still walking to in January.
   */
  lastActivity?: string;
  /** The units a teacher filed work under. A club files nothing. */
  topics?: string[];
  /** A sample of what the course actually asks for, titles and briefs. */
  work?: string[];
  /** How much work there is in total, since only a sample is shown. */
  workCount?: number;
  /** What gets posted to it, for a course that mostly posts. */
  announcements?: string[];
  /** What the teacher handed out. */
  materials?: string[];
  /** Whether anything here is marked. The clearest line between a subject and a room. */
  graded?: boolean;
}

export interface ClassifyOptions {
  courses: ClassifiableCourse[];
  /**
   * What the school page says about the school, where one has been written.
   *
   * Schools name their houses and their advisory programmes after all sorts of
   * things, and a room called French turned out to be a house on the first real
   * account. A researched page naming those structures is the only thing that
   * can tell them apart from the outside.
   */
  school?: string;
  /** ISO date. A model has no clock, and every question here is about time. */
  today: string;
  /**
   * When the school's academic year ends, as `MM-DD`.
   *
   * Researched into school.md and read back here. The dependency runs in a
   * circle -- school.md is written from a vault this filtered -- and resolves
   * because the filter re-runs on every build: the first uses the fallback,
   * writes school.md, and the next uses the real calendar.
   */
  yearEnd?: string;
  userId: string;
}

export interface CourseVerdict {
  /** The Classroom course name, as the snapshot has it. */
  course: string;
  /** A taught, graded class, as opposed to a club, advisory or house group. */
  academic: boolean;
  /** The document this course is written into. Two rooms of a subject share one. */
  subject: string;
  /** The academic year it belongs to, as `2025-2026`, where its name says so. */
  year: string | null;
  keep: boolean;
}

/**
 * Where a year ends when nothing has researched the school's calendar.
 *
 * July is after every northern-hemisphere school year and before every next
 * one, so a course still running in June survives and one that ended in June
 * does not linger past the summer.
 */
export const FALLBACK_YEAR_END = '07-01';

/**
 * How much of a course to show.
 *
 * Nineteen courses with a year of work each will not fit in a prompt, and do
 * not need to: what a course *is* shows in the first few things it asked for.
 * A count travels alongside the sample so a thin course still reads as thin.
 */
const SAMPLE = { work: 10, topics: 6, announcements: 3, materials: 5, brief: 160 } as const;

/** Past this share of a vault, a sweep is a bug rather than a filter. */
const MOST_OF_A_VAULT = 0.6;

export interface SweepResult {
  removed: number;
  /** True when the sweep declined, because what it was asked to take was too much. */
  refused: boolean;
}

const verdicts = z.object({
  courses: z
    .array(
      z.object({
        course: z.string(),
        academic: z.boolean(),
        subject: z.string(),
        year: z.string().nullish(),
      }),
    )
    .default([]),
});

const ASK = [
  'You are reading the full list of Google Classroom courses on one student’s account,',
  'and deciding what each one is. Judge them against each other: the list as a whole is',
  'what tells you that "Grade 11 Advisory" is not a subject the way its neighbours are.',
  '',
  'Reply with JSON only, no prose around it:',
  '{"courses": [{"course": string, "academic": boolean, "subject": string, "year": string | null}]}',
  '',
  'course must be copied exactly from the list you are given.',
  '',
  'academic is true for a taught subject: a body of knowledge with a syllabus, the',
  'kind of thing that appears on a report card. It is false for anything a student',
  'BELONGS TO rather than studies -- a house, an advisory or homeroom, a club, a team,',
  'a year-wide announcements room, a mentoring or wellbeing or careers programme.',
  '',
  'Decide from WHAT THE COURSE SETS, not from what it is called. This is the whole of',
  'the job and the one place it goes wrong.',
  '',
  'A taught subject sets work about its subject: texts to read, problems to solve,',
  'experiments, essays, a language to use. Its units are topics in a discipline.',
  '',
  'A room a student belongs to sets work about the student and about the group: how',
  'they learn, how they are getting on, what the group is doing. Reminders, sign-ups,',
  'assemblies, charity and social events, lunches, spirit days, house points, service',
  'hours, goal-setting and reflection, study skills, learner profiles, portfolios of',
  'their own progress. One of these among real coursework means nothing. Several, with',
  'no body of knowledge behind them, means this is not a subject however it is named.',
  '',
  'A school will name a house or an advisory after anything -- a colour, a founder, a',
  'building, a language. A room called "French" that sets a pizza lunch, a charity',
  'budget and a learner profile is a house called French. It is still something the',
  'student is in, and still belongs in their vault; it is not a French class, and',
  'saying it is puts a subject on their record that they do not take.',
  '',
  'So the name is corroboration and never the decision.',
  'Where the name and the contents disagree, the contents are right.',
  '',
  'Marks do not settle it either way: a robotics team marks work, and a house can set',
  'a graded reflection.',
  '',
  'subject is a short lowercase slug naming the class a student would say they have:',
  '"french", "math", "history", "model-un". It must come from THIS course\'s own name --',
  'never from what kind of thing you decided it is, so "advisory" is only ever the',
  'subject of a course that is actually an advisory. Strip the level, the year and the',
  'section: "GR10 - Design // 2025-26" is "design".',
  '',
  'Two rooms of the same subject -- different teachers, sets or halves of a year -- must',
  'be given the SAME subject, because they are one class to the student. Different',
  'subjects must never share one.',
  '',
  'year is the academic year the course belongs to, as "2025-2026", when the course',
  'name, its section or its year group says so. Use null when nothing states it. Do not',
  'guess it from how old the course feels.',
].join('\n');

export async function classifyCourses(
  { llm }: CourseClassifierDeps,
  { courses, today, yearEnd, school, userId }: ClassifyOptions,
): Promise<CourseVerdict[]> {
  if (courses.length === 0) return [];

  /*
   * Wrapped, because every word of it is a teacher's.
   *
   * Course names, briefs, handouts and announcements come straight off
   * Classroom. An announcement asserting that a course is a club -- or that all
   * of them are finished -- would otherwise arrive in the same voice as the
   * question being asked about it. The blast cap on the sweep stops the worst
   * outcome; this stops the attempt from reading as an instruction at all.
   */
  const listed = [
    '<untrusted>',
    untrustedNote('The courses below are described in their teachers’ own words.'),
    '',
    courses.map(describe).join('\n\n'),
    '</untrusted>',
  ].join('\n');

  let answered: z.infer<typeof verdicts>['courses'] = [];
  try {
    /*
     * Retried before it is allowed to fail open.
     *
     * Failing open on a rate limit means keeping every course this build, which
     * is safe and also wrong -- and on an account whose files are being read at
     * the same time, a 429 is the likeliest error there is.
     */
    const response = await retrying(() =>
      llm.chat(
        {
          messages: [
            { role: 'system', content: ASK },
            {
              role: 'user',
              content: [
                `Today is ${today}.`,
                school
                  ? `\nWhat is known about the school, which may name its houses and its\nadvisory or pastoral programmes:\n\n${school}\n`
                  : '',
                `\nThe courses:\n${listed}`,
              ].join('\n'),
            },
          ],
        },
        { userId },
      ),
    );
    answered = parse(response.content)?.courses ?? [];
  } catch {
    // Fails open, leaving `answered` empty: see the note at the top of this
    // file. Every course then falls through to the "not mentioned" branch and
    // is kept.
  }

  const byName = new Map(answered.map((verdict) => [verdict.course, verdict]));

  return courses.map((course) => {
    const said = byName.get(course.name);
    /*
     * A course the model did not mention is kept, not dropped.
     *
     * A truncated answer, a name it failed to copy back, a list longer than it
     * was willing to enumerate -- every one of those is silence, and silence
     * must never read as "delete this".
     */
    if (!said) {
      return {
        course: course.name,
        academic: true,
        subject: slugForNote(course.name),
        year: null,
        keep: true,
      };
    }

    const year = said.year ?? null;
    const ends = yearEnd ?? FALLBACK_YEAR_END;
    /*
     * Whether the course is over, in the order the answers can be trusted.
     *
     * When the vault knows when the course was last active, that settles it:
     * anything still moving since this academic year began is this year's,
     * whatever the school did with the archive button. Only where nothing is
     * dated do the weaker signals get a say.
     */
    const over = course.lastActivity
      ? course.lastActivity < academicYearStart(today, ends)
      : course.courseState === 'ARCHIVED' || hasEnded(year, today, ends);

    return {
      course: course.name,
      academic: said.academic,
      subject: slugForNote(said.subject),
      year,
      keep: !(said.academic && over),
    };
  });
}

/** Angle brackets folded, so nothing a school typed can close the wrapper. */
function defang(text: string): string {
  return text.replaceAll('<', '‹').replaceAll('>', '›');
}

/** One course, as much of it as fits, for the classifier to read. */
function describe(course: ClassifiableCourse): string {
  const some = (label: string, items: string[] | undefined, total?: number): string[] => {
    if (!items || items.length === 0) return [];
    const more = total !== undefined && total > items.length ? ` (${total} in all)` : '';
    return [`  ${label}${more}:`, ...items.map((item) => `    - ${item}`)];
  };

  return [
    `- ${defang(course.name)}`,
    ...(course.section ? [`  Section: ${defang(course.section)}`] : []),
    ...(course.courseState === 'ARCHIVED' ? ['  The school has archived this one.'] : []),
    ...(course.lastActivity ? [`  Last dated activity: ${course.lastActivity}`] : []),
    `  Anything in it marked: ${course.graded ? 'yes' : 'no'}`,
    ...some('Units', course.topics),
    ...some('Work it sets', course.work, course.workCount),
    ...some('Handouts', course.materials),
    ...some('What it posts', course.announcements),
  ].join('\n');
}

/**
 * The date this academic year began: the last year-end on or before today.
 *
 * Exported because the same boundary decides which year a course belongs to
 * here and how many years a student has moved up since a piece of mail called
 * them Grade 10.
 */
export function academicYearStart(today: string, yearEnd: string): string {
  const thisYear = `${today.slice(0, 4)}-${yearEnd}`;
  if (today >= thisYear) return thisYear;
  return `${Number(today.slice(0, 4)) - 1}-${yearEnd}`;
}

/**
 * Whether an academic year was over before today.
 *
 * Reads the later half of "2025-2026" -- the calendar year the school year ends
 * in -- and asks whether the school's own year-end has passed since.
 */
function hasEnded(year: string | null, today: string, yearEnd: string): boolean {
  if (!year) return false;

  const years = year.match(/\d{4}/g);
  const ends = years?.[years.length - 1];
  if (!ends) return false;

  return today >= `${ends}-${yearEnd}`;
}

function parse(content: unknown): z.infer<typeof verdicts> | null {
  if (typeof content !== 'string') return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = verdicts.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Everything about a course that helps say what kind of thing it is.
 *
 * The names alone are thin and sometimes actively misleading -- a house group
 * called French sits in the list beside the subject called French, which is the
 * pair that has already been got wrong on a real account. What separates them
 * is not the name: it is that one has units, work with briefs, and marks, and
 * the other has announcements about assemblies.
 *
 * Sampled rather than complete. See SAMPLE.
 */
export function describeCourses(snapshot: ClassroomSnapshot, today: string): ClassifiableCourse[] {
  const activity = lastActivityByCourse(snapshot, today);

  const forCourse = <T extends { course: string }>(items: T[], name: string): T[] =>
    items.filter((item) => item.course === name);

  /** Angle brackets folded, so nothing in a teacher's text can close the wrapper. */
  const trim = (text: string): string =>
    text
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SAMPLE.brief)
      .replaceAll('<', '‹')
      .replaceAll('>', '›');

  return snapshot.courses.map((course) => {
    const work = forCourse(snapshot.coursework, course.name);
    const marked = forCourse(snapshot.submissions, course.name).some(
      (submission) => submission.grade !== null || submission.maxPoints !== null,
    );

    return {
      id: course.id,
      name: course.name,
      ...(course.section ? { section: course.section } : {}),
      ...(course.courseState ? { courseState: course.courseState } : {}),
      ...(activity.has(course.name) ? { lastActivity: activity.get(course.name) as string } : {}),
      topics: forCourse(snapshot.topics, course.name)
        .slice(0, SAMPLE.topics)
        .map((topic) => topic.name),
      work: work
        .slice(0, SAMPLE.work)
        .map((item) =>
          trim(item.description ? `${item.title} -- ${item.description}` : item.title),
        ),
      workCount: work.length,
      announcements: forCourse(snapshot.announcements, course.name)
        .slice(0, SAMPLE.announcements)
        .map((announcement) => trim(announcement.text)),
      materials: forCourse(snapshot.materials, course.name)
        .slice(0, SAMPLE.materials)
        .map((material) => trim(material.title)),
      graded: marked,
    };
  });
}

/**
 * When each course was last doing anything, from the snapshot itself.
 *
 * Deadlines and announcement dates, whichever is newest. A course with work due
 * next month is this year's whatever the archive flag says, and a course whose
 * newest date is last June is not -- which is a better answer than either the
 * flag or a year written into a course name.
 *
 * A course where nothing carries a date is absent rather than old -- and so is
 * one whose only dates are still ahead of it. Nothing there can prove it is
 * over, and absent is the answer that keeps it.
 */
export function lastActivityByCourse(
  snapshot: ClassroomSnapshot,
  today: string,
): Map<string, string> {
  const newest = new Map<string, string>();

  const seen = (course: string, date: string | null | undefined) => {
    if (!date) return;
    /*
     * Only what has actually happened.
     *
     * A deadline is a plan, not evidence a course is running. A teacher on a
     * real account typed 2027 into a Grade 10 due date, and read as activity it
     * made a course the student finished in June look like this year's.
     */
    if (date.slice(0, 10) > today) return;
    const already = newest.get(course);
    if (!already || date > already) newest.set(course, date);
  };

  for (const work of snapshot.coursework) seen(work.course, work.due);
  for (const announcement of snapshot.announcements)
    seen(announcement.course, announcement.postedAt);

  return newest;
}

/**
 * Everything a dropped course brought with it, taken back out.
 *
 * Filtering here rather than in the collectors, because Classroom's list
 * endpoints answer for the whole account at once -- there is no per-course
 * request to skip. What this saves is the expensive half: the notes never get
 * written, so nothing links to them, `vault_search` never ranks them, and the
 * Drive files attached to them are never read, which is a model call each.
 *
 * A course with no verdict is kept, for the same reason the classifier keeps
 * one it did not mention: silence must never read as "delete this".
 */
export function filterSnapshot(
  snapshot: ClassroomSnapshot,
  verdicts: CourseVerdict[],
): ClassroomSnapshot {
  const dropped = new Set(verdicts.filter((v) => !v.keep).map((v) => v.course));
  if (dropped.size === 0) return snapshot;

  const kept = <T extends { course: string }>(items: T[]): T[] =>
    items.filter((item) => !dropped.has(item.course));

  return {
    courses: snapshot.courses.filter((course) => !dropped.has(course.name)),
    coursework: kept(snapshot.coursework),
    topics: kept(snapshot.topics),
    submissions: kept(snapshot.submissions),
    announcements: kept(snapshot.announcements),
    materials: kept(snapshot.materials),
  };
}

/**
 * Taking a dropped course out of a vault that already holds it.
 *
 * The snapshot filter stops new notes being written; this is what handles the
 * day the rule changes its mind about a course already on disk -- the morning
 * after a year ends, or a build after the classifier is corrected. Together
 * they are what makes the filter re-run safely on every build.
 *
 * The subtree comes from `buildGraph`, whose `cluster` is already "the nearest
 * course, walking the links backwards". One pass settles every note at once;
 * asking `backlinks` per course would re-read the whole vault per course.
 *
 * Two things are spared. A teacher outlives a course and may teach this student
 * again next year, and is evidence about the school besides. And anything the
 * student wrote themselves is theirs -- it was clustered under a course because
 * it mentioned one, but no import can ever write it again.
 */
export async function sweepDroppedCourses(
  vault: Vault,
  verdicts: CourseVerdict[],
): Promise<SweepResult> {
  const dropped = verdicts.filter((verdict) => !verdict.keep);
  if (dropped.length === 0) return { removed: 0, refused: false };

  const byName = new Set(dropped.map((verdict) => verdict.course));

  /*
   * Which notes on disk are the courses being dropped.
   *
   * Matched on the title the importer wrote -- the first line, up to the comma
   * -- rather than on a slug, because a second room of the same subject is
   * named `french-2` and would not be found by slugging its title. Courses
   * recovered from mail carry no Classroom id at all, so an id match alone
   * would miss exactly the ones nothing else can rediscover.
   */
  const courses = (await vault.list('entity')).filter((note) => note.description === 'Course');
  const goners = new Set(
    courses.filter((note) => byName.has(titleOf(note))).map((note) => note.name),
  );
  if (goners.size === 0) return { removed: 0, refused: false };

  const surviving = courses.filter((note) => !goners.has(note.name)).map((note) => note.name);
  const { nodes } = await buildGraph(vault);

  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);
  const bodies = new Map([...entities, ...episodes].map((note) => [note.name, note.body]));

  const condemned = nodes.filter((node) => {
    if (!node.cluster || !goners.has(node.cluster)) return false;
    // A teacher outlives the course, and may teach this student again.
    if (node.description === 'Person') return false;
    // The student's own words are theirs, and no import can write them again.
    if (node.source === 'student') return false;
    /*
     * And anything a surviving course also uses.
     *
     * A note is assigned one cluster, first come, so a revision sheet linked
     * from two courses lands under whichever was walked first. Deleting it on
     * that basis takes a file out of a course nobody dropped.
     */
    const body = bodies.get(node.name) ?? '';
    return !surviving.some((course) => body.includes(`[[${course}]]`));
  });

  /*
   * The blast cap.
   *
   * "All academic, all finished" is a plausible thing for a classifier to
   * answer and would take the entire vault. No single build should be able to
   * delete most of what a student has, so it declines and leaves a vault that
   * is merely stale rather than one that is empty.
   */
  if (condemned.length > nodes.length * MOST_OF_A_VAULT) return { removed: 0, refused: true };

  let removed = 0;
  /*
   * Episodes first, then everything else, and the course notes last.
   *
   * Not a constraint the store enforces -- it is so that an interrupted sweep
   * leaves a vault whose links still resolve, rather than a timeline of
   * episodes pointing at a course that has already gone.
   */
  const order = (kind: string, name: string) => (goners.has(name) ? 2 : kind === 'episode' ? 0 : 1);
  for (const node of [...condemned].sort((a, b) => order(a.kind, a.name) - order(b.kind, b.name))) {
    if (await vault.remove(node.kind, node.name)) removed += 1;
  }

  return { removed, refused: false };
}

/**
 * The name the importer wrote on the first line.
 *
 * Recovered by removing the suffix it appends, not by splitting on the first
 * comma: a course really can be called "Le parlement des jeunes, 8-10 avril
 * 2026", and splitting lost everything after "jeunes". Every course without a
 * comma matched, which is why it took counting pages against courses to see.
 */
function titleOf(note: VaultNote): string {
  const first = note.body.split('\n')[0] ?? '';
  return first.replace(/,\s*on Google Classroom\.?\s*$/i, '').trim();
}

/**
 * Files in the vault that belong to no course the student takes.
 *
 * The import will not bring one in any more, but a vault built before that
 * rule existed is full of them: on the first real account, a thousand of
 * twelve hundred, sitting in the picture attached to nothing and answering
 * searches about subjects that ended in June.
 *
 * Only files, and only ones nothing points at. A file a teacher attached in
 * Classroom carries its own course link and is somebody else's to remove; one
 * that any surviving note references is being used, whatever its folder said.
 */
export async function sweepUnattachedFiles(vault: Vault): Promise<{ removed: number }> {
  const [entities, episodes, documents] = await Promise.all([
    vault.list('entity'),
    vault.list('episode'),
    vault.list('document'),
  ]);

  const referenced = new Set<string>();
  for (const note of [...entities, ...episodes, ...documents]) {
    for (const match of note.body.matchAll(/\[\[([^\]]+)\]\]/g)) referenced.add(match[1] as string);
  }

  let removed = 0;
  for (const note of entities) {
    if (note.description !== 'File') continue;
    // Points at a course, or something points at it: either way it belongs.
    if (/^Part of \[\[/m.test(note.body)) continue;
    if (referenced.has(note.name)) continue;

    if (await vault.remove('entity', note.name)) removed += 1;
  }

  return { removed };
}

/**
 * Mail about classes they no longer take, taken out.
 *
 * The import will not bring one in any more, but a vault built before that rule
 * is full of them: on the first real account, nearly two hundred messages about
 * one dropped science course alone. Its course is gone and its assignments went
 * with it, and the mail stayed precisely because the course was removed
 * thoroughly enough that nothing was left to sweep it with.
 *
 * People are never touched. A teacher outlives the class they taught, may teach
 * this student again, and is evidence about the school besides -- and the
 * student's own words are theirs whatever they were about.
 */
export async function sweepCourseMail(
  vault: Vault,
  verdicts: CourseVerdict[],
): Promise<{ removed: number }> {
  const dropped = verdicts.filter((verdict) => !verdict.keep).map((verdict) => verdict.course);
  if (dropped.length === 0) return { removed: 0 };

  let removed = 0;
  for (const note of await vault.list('episode')) {
    // Their own words, which no import can write again.
    if (note.source === 'student') continue;
    if (!namesCourse(note.body, dropped)) continue;

    if (await vault.remove('episode', note.name)) removed += 1;
  }

  return { removed };
}
