import { isUnavailable } from '../tools/google/client.js';
import {
  listAnnouncements,
  listCourseMaterials,
  listCourses,
  listCoursework,
  listSubmissions,
  listTopics,
  type Announcement,
  type Assignment,
  type CourseMaterial,
  type SubmissionSummary,
  type Topic,
} from '../tools/google/classroom.js';
import type { ToolContext } from '../tools/types.js';
import type { ClassroomSnapshot } from './classroom.js';

/** Higher than any school's year. The importer wants the lot. */
const ALL = 100_000;

/**
 * Last year counts.
 *
 * A school archives a course when the year ends, and asking only for active
 * ones made six of this account's nineteen invisible -- both History courses,
 * Science and Technology, Model UN, Debating and the IB Personal Project. The
 * vault had no course to file a chemistry worksheet under and nothing at all
 * to say about what the student got in Science, because as far as it knew they
 * had never taken it.
 *
 * A conversation still defaults to current classes, because day to day that is
 * what a student means. A vault is the opposite: remembering last year is the
 * whole point of one.
 */
const EVERY_YEAR = true;

/**
 * Fetching what Classroom knows, through the tools that already know how.
 *
 * Deliberately reuses the agent's own tools rather than calling the Google API
 * again: scope handling, pagination, the wildcard trick that keeps submissions
 * to one request per course, and the mapping of Classroom's enums into words
 * all live there already. A second implementation would drift, and it would
 * drift silently because only one of them has a student in front of it.
 *
 * Every source is optional. A school that granted courses but not coursework
 * gets a smaller vault, not a failed import -- and the caller is told which
 * parts were missing rather than being left to infer it from a thin result.
 */

export interface Collected {
  snapshot: ClassroomSnapshot;
  /** Sources that could not be read, and why, in words a person can act on. */
  skipped: string[];
}

/**
 * Run one tool and pull a named array out of it.
 *
 * Tools answer with `{ unavailable: ... }` when a scope is missing rather than
 * throwing, because a partial grant is an ordinary state rather than an error.
 */
async function collect<T>(
  label: string,
  run: () => Promise<unknown>,
  key: string,
  skipped: string[],
): Promise<T[]> {
  let result: unknown;
  try {
    result = await run();
  } catch (error) {
    skipped.push(`${label}: ${(error as Error).message}`);
    return [];
  }

  if (isUnavailable(result)) {
    skipped.push(`${label}: not available (scope not granted, or not connected)`);
    return [];
  }

  const value = (result as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function collectClassroomSnapshot(ctx: ToolContext): Promise<Collected> {
  const skipped: string[] = [];

  const courses = await collect<{ id: string; name: string }>(
    'courses',
    () => listCourses.execute({ includeArchived: EVERY_YEAR } as never, ctx),
    'courses',
    skipped,
  );

  // Nothing else is reachable without courses, and asking anyway produces
  // three more identical failures for the same reason.
  if (courses.length === 0) {
    return {
      snapshot: {
        courses: [],
        coursework: [],
        topics: [],
        submissions: [],
        announcements: [],
        materials: [],
      },
      skipped,
    };
  }

  const [coursework, topics, submissions, announcements, materials] = await Promise.all([
    // includeCompleted, because a vault of only outstanding work forgets
    // everything the moment it is handed in.
    collect<Assignment>(
      'coursework',
      () =>
        listCoursework.execute(
          { includeCompleted: true, limit: ALL, includeArchived: EVERY_YEAR } as never,
          ctx,
        ),
      'assignments',
      skipped,
    ),
    collect<Topic>(
      'topics',
      () => listTopics.execute({ includeArchived: EVERY_YEAR } as never, ctx),
      'topics',
      skipped,
    ),
    collect<SubmissionSummary>(
      'submissions',
      () => listSubmissions.execute({ limit: ALL, includeArchived: EVERY_YEAR } as never, ctx),
      'submissions',
      skipped,
    ),
    /*
     * The half that was missing.
     *
     * On a real account these two were four hundred and eighty-seven items
     * against the four hundred that were already being imported -- and they
     * are the half that says what actually happened in a course rather than
     * what it contains.
     */
    /*
     * EVERYTHING, explicitly.
     *
     * These tools hand a conversation a page, because a year of announcements
     * is forty thousand tokens and no turn should carry that. The importer is
     * the opposite case: it wants all of them and spends no model call on any
     * of them, so it says so rather than inheriting a limit meant for a chat.
     */
    collect<Announcement>(
      'announcements',
      () => listAnnouncements.execute({ limit: ALL, includeArchived: EVERY_YEAR } as never, ctx),
      'announcements',
      skipped,
    ),
    collect<CourseMaterial>(
      'materials',
      () => listCourseMaterials.execute({ limit: ALL, includeArchived: EVERY_YEAR } as never, ctx),
      'materials',
      skipped,
    ),
  ]);

  return {
    snapshot: { courses, coursework, topics, submissions, announcements, materials },
    skipped,
  };
}
