import { z } from 'zod';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';
import { googleFetch, isUnavailable } from './client.js';

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
