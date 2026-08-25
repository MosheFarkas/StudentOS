import { z } from 'zod';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';
import { googleFetch, isUnavailable } from './client.js';
import {
  CLASSROOM_ANNOUNCEMENTS_SCOPE,
  CLASSROOM_COURSES_SCOPE,
  CLASSROOM_COURSEWORK_SCOPE,
  CLASSROOM_COURSEWORK_WRITE_SCOPE,
  CLASSROOM_MATERIALS_SCOPE,
  CLASSROOM_SUBMISSIONS_SCOPE,
  CLASSROOM_TOPICS_SCOPE,
} from './scopes.js';

const COURSES_URL = 'https://classroom.googleapis.com/v1/courses';

/** Stops a pathological account from looping forever on paging. */
const MAX_PAGES = 20;

/**
 * List active courses.
 *
 * Needs only the course scope, which is the one required for the Classroom
 * group at all -- so a student whose school approved a subset always has at
 * least this working, rather than a connection that is green and does nothing.
 */
/**
 * Which course states count.
 *
 * A school archives a course when the year ends. On a real account in August,
 * six of nineteen were archived -- both History courses, Science and
 * Technology, Model UN, Debating and the IB Personal Project -- and asking for
 * ACTIVE alone made every one of them invisible. The vault had no course to
 * file a chemistry worksheet under and no way to answer what a student got in
 * Science, because as far as it knew they had never taken it.
 *
 * A conversation still gets the current classes by default, because day to day
 * that is what a student means. The vault asks for everything, because last
 * year is exactly what a vault is for.
 */
/*
 * Whole query fragments, not values, because courseStates is a repeated field.
 * `courseStates=ACTIVE,ARCHIVED` is a 400 from Classroom -- verified against
 * the real API after a comma-joined version silently took the whole import
 * down to zero courses.
 */
const STATES_NOW = 'courseStates=ACTIVE';
const STATES_EVER = 'courseStates=ACTIVE&courseStates=ARCHIVED';

const includeArchived = {
  includeArchived: z
    .boolean()
    .optional()
    .describe('Also list courses from previous years, which the school has archived.'),
};

export const listCourses: Tool<{ includeArchived?: boolean }, unknown> = {
  id: 'google_classroom_list_courses',
  requiredScopes: [CLASSROOM_COURSES_SCOPE],
  description:
    'List the courses the student is enrolled in. Call this when they ask what classes ' +
    'they are taking, or when you need a course name or id for another lookup. Pass ' +
    'includeArchived when they ask about a previous year or a subject they no longer take.',
  inputSchema: z.object(includeArchived),

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Contexto.',
      );
    }

    const result = await googleFetch<{ courses?: { id: string; name?: string }[] }>(
      `${COURSES_URL}?${input.includeArchived ? STATES_EVER : STATES_NOW}`,
      token,
      { ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (isUnavailable(result)) return result;

    const courses = (result.courses ?? []).map((c) => ({ id: c.id, name: c.name ?? 'Untitled' }));
    return { courses, count: courses.length };
  },
};

/**
 * Google Classroom tools.
 *
 * Read ./scopes.ts before changing anything here. Classroom is the integration
 * most likely to be unavailable for a given student, for reasons entirely
 * outside their control: their Workspace admin has to have approved this app
 * before an under-18 account can use it at all.
 *
 * Treat unavailable as a normal state, not an error. The agent must stay
 * useful without Classroom -- most students will never have it.
 */

/**
 * How many items a list tool hands the model in one call.
 *
 * Measured on a real account: one call to list_materials returned 46,613
 * tokens and list_announcements 37,751. Two in a turn is 84,000 tokens before
 * the model has said anything -- a turn that fails outright against a
 * per-minute token limit, and on any account one that costs more than the
 * entire one-off import of the student's Drive.
 *
 * The year really is that big. Handing all of it over at once is the mistake,
 * not the size of the year. A caller that genuinely needs everything -- the
 * vault importer, which spends no model call on it -- asks for it explicitly.
 */
export const MODEL_PAGE = 25;

const pageInput = {
  ...includeArchived,
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`How many to return. Defaults to ${MODEL_PAGE}, newest first.`),
  course: z
    .string()
    .optional()
    .describe('Only this course, by name. The way to see past the first page.'),
};

/** Narrow to one course, then to one page, and say what was left behind. */
function page<T extends { course: string }>(
  items: T[],
  input: { limit?: number; course?: string },
  noun: string,
): { items: T[]; total: number; more?: string } {
  const wanted = input.course
    ? items.filter((item) => item.course.toLowerCase().includes(input.course!.toLowerCase()))
    : items;

  const limit = input.limit ?? MODEL_PAGE;
  if (wanted.length <= limit) return { items: wanted, total: wanted.length };

  /*
   * Truncating silently is worse than refusing.
   *
   * The model reports "that is everything" about a slice it was never told
   * was a slice, and the student believes it. So the count and the way to
   * narrow travel with the page.
   */
  return {
    items: wanted.slice(0, limit),
    total: wanted.length,
    more:
      `Showing the newest ${limit} of ${wanted.length} ${noun}. ` +
      'Ask again with a course name to see that course, or a bigger limit.',
  };
}

const listCourseworkInput = z.object({
  includeCompleted: z
    .boolean()
    .default(false)
    .describe('Include assignments the student has already turned in'),
  ...pageInput,
});

interface CourseList {
  courses?: { id: string; name?: string; courseState?: string }[];
}

interface CourseWorkList {
  courseWork?: {
    id: string;
    title?: string;
    description?: string;
    dueDate?: { year: number; month: number; day: number };
    dueTime?: { hours?: number; minutes?: number };
    alternateLink?: string;
    topicId?: string;
    materials?: ClassroomMaterial[];
  }[];
}

export interface Assignment {
  id: string;
  course: string;
  title: string;
  /**
   * Which unit of the course this belongs to, when the teacher filed it.
   *
   * Classroom returns it and this was dropping it. It is the only edge in the
   * imported data that does not point at a course, and without it ContextoVault
   * is a star -- every assignment pointing at its course and nothing pointing
   * at anything else.
   */
  topicId?: string;
  due: string | null;
  link?: string;
  /**
   * What the teacher attached. Where the homework actually is.
   *
   * Classroom returns these and this was dropping them, so the vault knew an
   * assignment existed and nothing about the template, the reading or the
   * worksheet needed to do it.
   */
  attachments?: Attachment[];
}

export const listCoursework: Tool<z.infer<typeof listCourseworkInput>, unknown> = {
  id: 'google_classroom_list_coursework',
  // courseWork.list genuinely requires the coursework scope -- listing courses
  // is not enough. Schools that withhold it get the course tool and not this
  // one, rather than a tool that 403s on every call.
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_COURSEWORK_SCOPE],
  description:
    "List the student's assignments and their due dates. Call this when the question " +
    'involves upcoming work, deadlines, or what a course requires.',
  inputSchema: listCourseworkInput,

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      // Says "or your school has not approved" deliberately. For a managed
      // under-18 account this is not something the student can fix, and a bare
      // "not connected" sends them round a loop trying to connect it.
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Contexto. ' +
          'You can still use everything else.',
      );
    }

    const courses = await googleFetch<CourseList>(
      `https://classroom.googleapis.com/v1/courses?${
        input.includeArchived ? STATES_EVER : STATES_NOW
      }`,
      token,
      { ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (isUnavailable(courses)) return courses;

    const active = courses.courses ?? [];
    if (active.length === 0) {
      return { assignments: [], count: 0, note: 'No active courses found.' };
    }

    // Sequential rather than parallel: a student with 8 courses firing 8
    // simultaneous requests is the shape that trips Classroom's per-user rate
    // limit, and the latency saved is not worth the failure mode.
    const assignments: Assignment[] = [];
    for (const course of active) {
      const work = await googleFetch<CourseWorkList>(
        `https://classroom.googleapis.com/v1/courses/${course.id}/courseWork`,
        token,
        { ...(ctx.signal ? { signal: ctx.signal } : {}) },
      );
      // One inaccessible course should not fail the whole answer.
      if (isUnavailable(work)) continue;

      for (const item of work.courseWork ?? []) {
        const attachments = toAttachments(item.materials);
        assignments.push({
          id: item.id,
          course: course.name ?? 'Unknown course',
          title: item.title ?? '(untitled)',
          due: formatDue(item.dueDate, item.dueTime),
          ...(item.topicId ? { topicId: item.topicId } : {}),
          ...(item.alternateLink ? { link: item.alternateLink } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      }
    }

    // Undated work sorts last -- "no due date" is not urgent.
    assignments.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));

    const shown = page(assignments, input, 'assignments');
    return {
      assignments: shown.items,
      count: shown.items.length,
      total: shown.total,
      ...(shown.more ? { more: shown.more } : {}),
    };
  },
};

/** Attachments Classroom hangs off materials, announcements, and coursework. */
interface ClassroomMaterial {
  driveFile?: { driveFile?: { id?: string; title?: string; alternateLink?: string } };
  youtubeVideo?: { title?: string; alternateLink?: string };
  link?: { title?: string; url?: string };
  form?: { title?: string; formUrl?: string };
}

export interface Attachment {
  kind: 'file' | 'video' | 'link' | 'form';
  title: string;
  url?: string;
  /** Drive id, for reading the file's contents. Files only. */
  fileId?: string;
}

function toAttachments(materials: ClassroomMaterial[] | undefined): Attachment[] {
  return (materials ?? []).flatMap((m): Attachment[] => {
    if (m.driveFile?.driveFile) {
      const f = m.driveFile.driveFile;
      return [
        {
          kind: 'file',
          title: f.title ?? 'Untitled file',
          ...(f.alternateLink ? { url: f.alternateLink } : {}),
          // Carried so the read tool has a handle. Without it the agent can
          // name a file and has no way to open it.
          ...(f.id ? { fileId: f.id } : {}),
        },
      ];
    }
    if (m.youtubeVideo) {
      return [
        {
          kind: 'video',
          title: m.youtubeVideo.title ?? 'Video',
          ...(m.youtubeVideo.alternateLink ? { url: m.youtubeVideo.alternateLink } : {}),
        },
      ];
    }
    if (m.link) {
      return [
        {
          kind: 'link',
          title: m.link.title ?? m.link.url ?? 'Link',
          ...(m.link.url ? { url: m.link.url } : {}),
        },
      ];
    }
    if (m.form) {
      return [
        {
          kind: 'form',
          title: m.form.title ?? 'Form',
          ...(m.form.formUrl ? { url: m.form.formUrl } : {}),
        },
      ];
    }
    return [];
  });
}

/**
 * Fetch across every active course, sequentially.
 *
 * Not parallel: a student with eight courses firing eight simultaneous
 * requests is the shape that trips Classroom's per-user rate limit, and the
 * latency saved is not worth the failure mode. One inaccessible course is
 * skipped rather than failing the whole answer.
 */
async function forEachCourse<T>(
  token: string,
  signal: AbortSignal | undefined,
  path: (courseId: string) => string,
  extract: (payload: never, courseName: string) => T[],
  archived = false,
): Promise<T[] | ReturnType<typeof unavailable>> {
  const courses = await googleFetch<{ courses?: { id: string; name?: string }[] }>(
    `${COURSES_URL}?${archived ? STATES_EVER : STATES_NOW}`,
    token,
    { ...(signal ? { signal } : {}) },
  );
  if (isUnavailable(courses)) return courses;

  const out: T[] = [];
  /*
   * Whether a single request was actually answered.
   *
   * Without this a withheld scope is indistinguishable from a quiet year:
   * every per-course fetch 403s, each one is skipped so that one locked
   * course cannot spoil the rest, and the caller gets an empty list that
   * reads as "the teachers posted nothing". A student is then told their
   * school has no announcements, when the truth is that nobody was allowed
   * to look.
   */
  let answered = false;

  for (const course of courses.courses ?? []) {
    let pageToken: string | undefined;

    /*
     * Followed to the end rather than taking the first page. Today every
     * course fits in one -- measured, 234 items either way -- but a page cap
     * that silently drops a student's coursework is the kind of bug that
     * looks like the teacher never posted it.
     */
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const base = path(course.id);
      const url = pageToken
        ? `${base}${base.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(pageToken)}`
        : base;

      const payload = await googleFetch<{ nextPageToken?: string }>(url, token, {
        ...(signal ? { signal } : {}),
      });
      if (isUnavailable(payload)) break;
      answered = true;

      out.push(...extract(payload as never, course.name ?? 'Unknown course'));
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
    }
  }

  // Courses existed and not one of them could be read: that is a refusal, not
  // an empty year, and the difference is the whole point of saying so.
  if (!answered && (courses.courses ?? []).length > 0) {
    return unavailable('Classroom refused every course for this. The scope may not be granted.');
  }
  return out;
}

export interface CourseMaterial {
  /** Classroom's own id. What makes a re-import an update rather than a copy. */
  id: string;
  course: string;
  title: string;
  description?: string;
  attachments: Attachment[];
  link?: string;
}

export const listCourseMaterials: Tool<
  { limit?: number; course?: string; includeArchived?: boolean },
  unknown
> = {
  id: 'google_classroom_list_materials',
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_MATERIALS_SCOPE],
  description:
    "List the files, slides, videos, and links teachers have posted to the student's courses. " +
    'Call this when they ask about class materials, readings, notes, or "the files" for a ' +
    'course. Each attachment carries a fileId you can pass straight to google_drive_read_file ' +
    'to read its contents. If a file is not here, check google_classroom_list_announcements -- ' +
    'teachers attach files to announcements as well. Searching Drive by name ' +
    'will often miss them, because Drive omits files the student has never opened. ' +
    "Include each item's link as a markdown link too, so the student can open it themselves.",
  inputSchema: z.object(pageInput),

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Contexto.',
      );
    }

    const materials = await forEachCourse<CourseMaterial>(
      token,
      ctx.signal,
      (id) => `${COURSES_URL}/${id}/courseWorkMaterials?pageSize=100`,
      (payload: { courseWorkMaterial?: RawMaterial[] }, courseName) =>
        (payload.courseWorkMaterial ?? []).map((item) => ({
          id: item.id ?? '',
          course: courseName,
          title: item.title ?? 'Untitled',
          ...(item.description ? { description: item.description } : {}),
          attachments: toAttachments(item.materials),
          ...(item.alternateLink ? { link: item.alternateLink } : {}),
        })),
      input.includeArchived,
    );
    if (isUnavailable(materials)) return materials;

    const shown = page(materials, input, 'materials');
    return {
      materials: shown.items,
      count: shown.items.length,
      total: shown.total,
      ...(shown.more ? { more: shown.more } : {}),
    };
  },
};

interface RawMaterial {
  id?: string;
  title?: string;
  description?: string;
  alternateLink?: string;
  materials?: ClassroomMaterial[];
}

export interface Announcement {
  /** Classroom's own id. What makes a re-import an update rather than a copy. */
  id: string;
  course: string;
  text: string;
  postedAt?: string;
  attachments: Attachment[];
  link?: string;
}

export const listAnnouncements: Tool<
  { limit?: number; course?: string; includeArchived?: boolean },
  unknown
> = {
  id: 'google_classroom_list_announcements',
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_ANNOUNCEMENTS_SCOPE],
  description:
    "List announcements teachers have posted to the student's courses. Call this when they " +
    'ask what a teacher said, what they missed, or what is new in a class. IMPORTANT: teachers ' +
    'also attach FILES to announcements, and those attachments carry a fileId you can pass to ' +
    'google_drive_read_file. If a file is not in google_classroom_list_materials, look here ' +
    'before concluding it does not exist.',
  inputSchema: z.object(pageInput),

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Contexto.',
      );
    }

    const announcements = await forEachCourse<Announcement>(
      token,
      ctx.signal,
      (id) => `${COURSES_URL}/${id}/announcements?pageSize=100`,
      (payload: { announcements?: RawAnnouncement[] }, courseName) =>
        (payload.announcements ?? []).map((item) => ({
          id: item.id ?? '',
          course: courseName,
          text: item.text ?? '',
          ...(item.creationTime ? { postedAt: item.creationTime } : {}),
          attachments: toAttachments(item.materials),
          ...(item.alternateLink ? { link: item.alternateLink } : {}),
        })),
      input.includeArchived,
    );
    if (isUnavailable(announcements)) return announcements;

    // Newest first -- "what did I miss" is almost always about recent posts,
    // and it is what makes the first page the right page.
    announcements.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
    const shown = page(announcements, input, 'announcements');
    return {
      announcements: shown.items,
      count: shown.items.length,
      total: shown.total,
      ...(shown.more ? { more: shown.more } : {}),
    };
  },
};

interface RawAnnouncement {
  id?: string;
  text?: string;
  creationTime?: string;
  alternateLink?: string;
  materials?: ClassroomMaterial[];
}

/**
 * Classroom splits due date and time into separate objects, and omits `dueTime`
 * entirely for whole-day deadlines. Returns ISO-ish text the model can reason
 * about, or null when the assignment genuinely has no deadline.
 */
function formatDue(
  date: { year: number; month: number; day: number } | undefined,
  time: { hours?: number; minutes?: number } | undefined,
): string | null {
  if (!date) return null;

  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.year}-${pad(date.month)}-${pad(date.day)}`;
  if (!time) return day;

  return `${day}T${pad(time.hours ?? 0)}:${pad(time.minutes ?? 0)}`;
}

/* ==========================================================================
 * Parity with what a student can do in the Classroom UI.
 *
 * The tools below exist because the goal is that the agent can reach anything
 * a student could reach by opening Classroom themselves, and change anything
 * they could change there. Two limits on that, both Google's rather than ours:
 *
 *   1. Scopes. A tool is registered only when its scope is granted, so a
 *      school that withholds one loses that tool and nothing else.
 *   2. The API is narrower than the UI. Private and class comments have NO
 *      endpoint -- not a scope problem, simply absent from the API. Nothing
 *      here can reach them, and the agent should say so rather than pretend.
 * ========================================================================== */

export interface SubmissionSummary {
  /**
   * The student's own copy of the work, when they attached one.
   *
   * Classroom's "make a copy for each student" gives every student a separate
   * file under its own id; the teacher's master, named "[Template] ...", is
   * never shared with them. Reading only the master meant holding blanks that
   * 404 and none of the work done on them.
   */
  attachments?: Attachment[];
  course: string;
  assignment: string;
  state: string;
  late: boolean;
  grade: number | null;
  maxPoints: number | null;
  submissionId: string;
  courseId: string;
  courseWorkId: string;
  link?: string;
}

const SUBMISSION_STATES: Record<string, string> = {
  NEW: 'not started',
  CREATED: 'not turned in',
  TURNED_IN: 'turned in',
  RETURNED: 'graded and returned',
  RECLAIMED_BY_STUDENT: 'taken back',
};

/**
 * Grades and turn-in status.
 *
 * Uses the `-` wildcard for courseWork, which asks Classroom for every
 * submission in a course in one call. Iterating assignments instead would be
 * one request per assignment per course -- on a 14-course account that is
 * hundreds of calls and a guaranteed rate limit.
 */
export const listSubmissions: Tool<
  { limit?: number; course?: string; includeArchived?: boolean },
  unknown
> = {
  id: 'google_classroom_list_submissions',
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_SUBMISSIONS_SCOPE],
  description:
    "List the student's own work: what is turned in, what is missing, what is late, and any " +
    'grades they have been given. Call this when they ask how they are doing, what they still ' +
    'owe, what they got on something, or whether they handed something in.',
  inputSchema: z.object(pageInput),

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Contexto.',
      );
    }

    const submissions = await forEachCourse<SubmissionSummary>(
      token,
      ctx.signal,
      (id) => `${COURSES_URL}/${id}/courseWork/-/studentSubmissions?pageSize=200`,
      (payload: { studentSubmissions?: RawSubmission[] }, courseName) =>
        (payload.studentSubmissions ?? []).map((s) => ({
          course: courseName,
          // The API returns no assignment title here; the agent can join on
          // courseWorkId via list_coursework when the student needs names.
          assignment: s.courseWorkId ?? '(unknown assignment)',
          state: SUBMISSION_STATES[s.state ?? ''] ?? (s.state ?? 'unknown').toLowerCase(),
          late: s.late === true,
          grade: typeof s.assignedGrade === 'number' ? s.assignedGrade : null,
          maxPoints: null,
          submissionId: s.id ?? '',
          courseId: s.courseId ?? '',
          courseWorkId: s.courseWorkId ?? '',
          ...(() => {
            const mine = toSubmissionAttachments(s.assignmentSubmission?.attachments);
            return mine.length > 0 ? { attachments: mine } : {};
          })(),
          ...(s.alternateLink ? { link: s.alternateLink } : {}),
        })),
      input.includeArchived,
    );
    if (isUnavailable(submissions)) return submissions;

    const late = submissions.filter((s) => s.late).length;
    const missing = submissions.filter((s) => s.state === 'not turned in').length;

    const shown = page(submissions, input, 'submissions');
    return {
      submissions: shown.items,
      count: shown.items.length,
      total: shown.total,
      ...(shown.more ? { more: shown.more } : {}),
      late,
      missing,
      note:
        'assignment holds a courseWorkId, not a title. Use google_classroom_list_coursework ' +
        'to match ids to assignment names when the student needs to know which is which.',
    };
  },
};

/**
 * What a student attached to their submission.
 *
 * Shaped differently from a coursework material, which nests it as
 * `driveFile.driveFile`. A submission does not nest it, and running the
 * coursework mapper over one silently produces nothing at all -- which is what
 * happened: 57 files of the student's own work mapped to zero.
 */
interface SubmissionAttachment {
  driveFile?: { id?: string; title?: string; alternateLink?: string };
  youTubeVideo?: { title?: string; alternateLink?: string };
  link?: { title?: string; url?: string };
  form?: { title?: string; formUrl?: string };
}

function toSubmissionAttachments(items: SubmissionAttachment[] | undefined): Attachment[] {
  return (items ?? []).flatMap((item): Attachment[] => {
    if (item.driveFile?.id) {
      return [
        {
          kind: 'file',
          title: item.driveFile.title ?? 'Untitled file',
          ...(item.driveFile.alternateLink ? { url: item.driveFile.alternateLink } : {}),
          fileId: item.driveFile.id,
        },
      ];
    }
    if (item.link?.url)
      return [{ kind: 'link', title: item.link.title ?? item.link.url, url: item.link.url }];
    // A video or a form handed in is a URL, not something that can be read.
    return [];
  });
}

interface RawSubmission {
  assignmentSubmission?: { attachments?: SubmissionAttachment[] };
  id?: string;
  courseId?: string;
  courseWorkId?: string;
  state?: string;
  late?: boolean;
  assignedGrade?: number;
  alternateLink?: string;
}

export interface Topic {
  course: string;
  name: string;
  topicId: string;
}

export const listTopics: Tool<{ includeArchived?: boolean }, unknown> = {
  id: 'google_classroom_list_topics',
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_TOPICS_SCOPE],
  description:
    'List the topics (units or sections) teachers use to organise each course. Useful when a ' +
    'student asks what a class covers, or refers to a unit by name.',
  inputSchema: z.object(includeArchived),

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Contexto.',
      );
    }

    const topics = await forEachCourse<Topic>(
      token,
      ctx.signal,
      (id) => `${COURSES_URL}/${id}/topics?pageSize=100`,
      (payload: { topic?: { topicId?: string; name?: string }[] }, courseName) =>
        (payload.topic ?? []).map((t) => ({
          course: courseName,
          name: t.name ?? 'Untitled topic',
          topicId: t.topicId ?? '',
        })),
      input.includeArchived,
    );
    if (isUnavailable(topics)) return topics;

    return { topics, count: topics.length };
  },
};

const submissionRefInput = z.object({
  courseId: z.string().min(1).describe('From google_classroom_list_submissions'),
  courseWorkId: z.string().min(1).describe('From google_classroom_list_submissions'),
  submissionId: z.string().min(1).describe('From google_classroom_list_submissions'),
});

/**
 * Turn work in.
 *
 * Gated on an ELECTIVE scope, so it exists only for a student who explicitly
 * asked for it. Handing work in is not undoable on the student's side once a
 * teacher returns it, and it is their name on the submission -- so the
 * description tells the model to confirm first. That instruction is a
 * safeguard, not a guarantee: the real control is that the scope is off by
 * default.
 */
export const turnInAssignment: Tool<z.infer<typeof submissionRefInput>, unknown> = {
  id: 'google_classroom_turn_in',
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_COURSEWORK_WRITE_SCOPE],
  description:
    "Turn in an assignment on the student's behalf. This submits their work under their name, " +
    'so ALWAYS confirm with them which assignment, and that they are ready, before calling it. ' +
    'Never turn work in as a side effect of another request.',
  inputSchema: submissionRefInput,

  async execute({ courseId, courseWorkId, submissionId }, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable('Google Classroom is not connected.');
    }

    const result = await googleFetch<Record<string, never>>(
      `${COURSES_URL}/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${submissionId}:turnIn`,
      token,
      { method: 'POST', body: {}, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (isUnavailable(result)) return result;

    return { turnedIn: true, note: 'The assignment is now turned in.' };
  },
};

export const unsubmitAssignment: Tool<z.infer<typeof submissionRefInput>, unknown> = {
  id: 'google_classroom_unsubmit',
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_COURSEWORK_WRITE_SCOPE],
  description:
    'Take back an assignment the student has turned in, so they can keep working on it. ' +
    'Confirm with them first. Note this can mark the work late if they resubmit after the ' +
    'due date.',
  inputSchema: submissionRefInput,

  async execute({ courseId, courseWorkId, submissionId }, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable('Google Classroom is not connected.');
    }

    const result = await googleFetch<Record<string, never>>(
      `${COURSES_URL}/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${submissionId}:reclaim`,
      token,
      { method: 'POST', body: {}, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (isUnavailable(result)) return result;

    return { reclaimed: true, note: 'Taken back. It is no longer turned in.' };
  },
};

const attachInput = submissionRefInput.extend({
  fileId: z.string().min(1).describe('Drive file id to attach, from google_drive_list_files'),
});

export const attachToSubmission: Tool<z.infer<typeof attachInput>, unknown> = {
  id: 'google_classroom_attach_file',
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_COURSEWORK_WRITE_SCOPE],
  description:
    'Attach a Drive file to an assignment the student has not turned in yet. Does NOT turn it ' +
    'in -- use google_classroom_turn_in for that, as a separate confirmed step.',
  inputSchema: attachInput,

  async execute({ courseId, courseWorkId, submissionId, fileId }, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable('Google Classroom is not connected.');
    }

    const result = await googleFetch<Record<string, never>>(
      `${COURSES_URL}/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${submissionId}` +
        ':modifyAttachments',
      token,
      {
        method: 'POST',
        body: { addAttachments: [{ driveFile: { id: fileId } }] },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    if (isUnavailable(result)) return result;

    return { attached: true, note: 'Attached. Not turned in yet.' };
  },
};
