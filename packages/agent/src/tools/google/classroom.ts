import { z } from 'zod';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';
import { googleFetch, isUnavailable } from './client.js';
import {
  CLASSROOM_ANNOUNCEMENTS_SCOPE,
  CLASSROOM_COURSES_SCOPE,
  CLASSROOM_COURSEWORK_SCOPE,
  CLASSROOM_MATERIALS_SCOPE,
} from './scopes.js';

const COURSES_URL = 'https://classroom.googleapis.com/v1/courses';

/**
 * List active courses.
 *
 * Needs only the course scope, which is the one required for the Classroom
 * group at all -- so a student whose school approved a subset always has at
 * least this working, rather than a connection that is green and does nothing.
 */
export const listCourses: Tool<Record<string, never>, unknown> = {
  id: 'google_classroom_list_courses',
  requiredScopes: [CLASSROOM_COURSES_SCOPE],
  description:
    'List the courses the student is enrolled in. Call this when they ask what classes ' +
    'they are taking, or when you need a course name or id for another lookup.',
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Contexto.',
      );
    }

    const result = await googleFetch<{ courses?: { id: string; name?: string }[] }>(
      `${COURSES_URL}?courseStates=ACTIVE`,
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

const listCourseworkInput = z.object({
  includeCompleted: z
    .boolean()
    .default(false)
    .describe('Include assignments the student has already turned in'),
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
  }[];
}

export interface Assignment {
  id: string;
  course: string;
  title: string;
  due: string | null;
  link?: string;
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

  async execute(_input, ctx) {
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
      'https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE',
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
        assignments.push({
          id: item.id,
          course: course.name ?? 'Unknown course',
          title: item.title ?? '(untitled)',
          due: formatDue(item.dueDate, item.dueTime),
          ...(item.alternateLink ? { link: item.alternateLink } : {}),
        });
      }
    }

    // Undated work sorts last -- "no due date" is not urgent.
    assignments.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));

    return { assignments, count: assignments.length };
  },
};

/** Attachments Classroom hangs off materials, announcements, and coursework. */
interface ClassroomMaterial {
  driveFile?: { driveFile?: { title?: string; alternateLink?: string } };
  youtubeVideo?: { title?: string; alternateLink?: string };
  link?: { title?: string; url?: string };
  form?: { title?: string; formUrl?: string };
}

export interface Attachment {
  kind: 'file' | 'video' | 'link' | 'form';
  title: string;
  url?: string;
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
): Promise<T[] | ReturnType<typeof unavailable>> {
  const courses = await googleFetch<{ courses?: { id: string; name?: string }[] }>(
    `${COURSES_URL}?courseStates=ACTIVE`,
    token,
    { ...(signal ? { signal } : {}) },
  );
  if (isUnavailable(courses)) return courses;

  const out: T[] = [];
  for (const course of courses.courses ?? []) {
    const payload = await googleFetch(path(course.id), token, { ...(signal ? { signal } : {}) });
    if (isUnavailable(payload)) continue;
    out.push(...extract(payload as never, course.name ?? 'Unknown course'));
  }
  return out;
}

export interface CourseMaterial {
  course: string;
  title: string;
  description?: string;
  attachments: Attachment[];
  link?: string;
}

export const listCourseMaterials: Tool<Record<string, never>, unknown> = {
  id: 'google_classroom_list_materials',
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_MATERIALS_SCOPE],
  description:
    "List the files, slides, videos, and links teachers have posted to the student's " +
    'courses. Call this when they ask about class materials, readings, notes, or "the files" ' +
    'for a course. Returns titles and links -- you cannot read file contents.',
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Contexto.',
      );
    }

    const materials = await forEachCourse<CourseMaterial>(
      token,
      ctx.signal,
      (id) => `${COURSES_URL}/${id}/courseWorkMaterials`,
      (payload: { courseWorkMaterial?: RawMaterial[] }, courseName) =>
        (payload.courseWorkMaterial ?? []).map((item) => ({
          course: courseName,
          title: item.title ?? 'Untitled',
          ...(item.description ? { description: item.description } : {}),
          attachments: toAttachments(item.materials),
          ...(item.alternateLink ? { link: item.alternateLink } : {}),
        })),
    );
    if (isUnavailable(materials)) return materials;

    return { materials, count: materials.length };
  },
};

interface RawMaterial {
  title?: string;
  description?: string;
  alternateLink?: string;
  materials?: ClassroomMaterial[];
}

export interface Announcement {
  course: string;
  text: string;
  postedAt?: string;
  attachments: Attachment[];
  link?: string;
}

export const listAnnouncements: Tool<Record<string, never>, unknown> = {
  id: 'google_classroom_list_announcements',
  requiredScopes: [CLASSROOM_COURSES_SCOPE, CLASSROOM_ANNOUNCEMENTS_SCOPE],
  description:
    "List recent announcements teachers have posted to the student's courses. Call this " +
    'when they ask what their teacher said, what they missed, or what is new in a class.',
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Contexto.',
      );
    }

    const announcements = await forEachCourse<Announcement>(
      token,
      ctx.signal,
      (id) => `${COURSES_URL}/${id}/announcements?pageSize=20`,
      (payload: { announcements?: RawAnnouncement[] }, courseName) =>
        (payload.announcements ?? []).map((item) => ({
          course: courseName,
          text: item.text ?? '',
          ...(item.creationTime ? { postedAt: item.creationTime } : {}),
          attachments: toAttachments(item.materials),
          ...(item.alternateLink ? { link: item.alternateLink } : {}),
        })),
    );
    if (isUnavailable(announcements)) return announcements;

    // Newest first -- "what did I miss" is almost always about recent posts.
    announcements.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
    return { announcements, count: announcements.length };
  },
};

interface RawAnnouncement {
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
