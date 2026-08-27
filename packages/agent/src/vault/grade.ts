import { academicYearStart } from './courses.js';
import type { Vault } from './vault.js';

/**
 * Which year at school this student is in.
 *
 * Read, then counted forward. Reading alone is what the old pass did and it was
 * wrong every summer: every piece of mail on a real account said Grade 10,
 * because that is what it said in March, and on the 26th of August that student
 * was in Grade 11 with nothing anywhere saying so. Nobody writes down that they
 * have moved up. It has to be worked out.
 *
 * Arithmetic rather than a model call. It is counting year boundaries between
 * two dates, which is a thing code does correctly every time and a thing a
 * model does nearly every time -- and the answer sits in a document that shapes
 * every reply for a year.
 *
 * Only dated evidence counts. A year in a course name -- `grade-10-math` -- is
 * right until a student takes one class with an older cohort, and carries no
 * date to count from, which is how this was got wrong the first time.
 */

/** How a school writes a year group. Grade, Year and Form all appear. */
const STATED = /\b(?:Grade|Year|Form)\s+(1[0-3]|[1-9])\b/g;

/** July is after every northern-hemisphere year and before the next. */
const FALLBACK_YEAR_END = '07-01';

/** Nobody is in Grade 14. Past this, a count forward has outrun its evidence. */
const LEAVING = 12;

export interface GradeReading {
  /** The year they are in now, having counted forward. */
  grade: number;
  /** What the evidence actually said. */
  stated: number;
  /** When it said it. */
  on: string;
  /** How many academic years have ended since. */
  rolledForward: number;
}

export interface GradeOptions {
  /** ISO date. */
  today: string;
  /** `MM-DD`, from the school page. Falls back when nothing has researched it. */
  yearEnd?: string;
}

export async function readGrade(
  vault: Vault,
  { today, yearEnd }: GradeOptions,
): Promise<GradeReading | null> {
  const ends = yearEnd ?? FALLBACK_YEAR_END;

  /*
   * Episodes only, and only dated ones.
   *
   * An entity has no time on it, so a year read off one cannot be counted
   * forward -- and the entity most likely to carry a year is a course name,
   * which is the exact source that produced a wrong answer before.
   */
  const dated = (await vault.list('episode'))
    .filter((note) => note.occurred)
    .sort((a, b) => (b.occurred as string).localeCompare(a.occurred as string));

  for (const note of dated) {
    const matches = [...note.body.matchAll(STATED)];
    const first = matches[0]?.[1];
    if (!first) continue;

    const stated = Number(first);
    const on = note.occurred as string;
    const rolledForward = yearsEndedBetween(on, today, ends);

    return {
      grade: Math.min(stated + rolledForward, LEAVING),
      stated,
      on,
      rolledForward,
    };
  }

  return null;
}

/**
 * How many academic years have ended between one date and another.
 *
 * The year end on or before today is the start of the year we are in now. Every
 * year end after the statement and up to that one is a year the student has
 * finished since somebody wrote it down.
 */
function yearsEndedBetween(from: string, today: string, yearEnd: string): number {
  const current = academicYearStart(today, yearEnd);

  let ended = 0;
  for (let year = Number(from.slice(0, 4)); year <= Number(today.slice(0, 4)); year += 1) {
    const boundary = `${year}-${yearEnd}`;
    if (boundary > from.slice(0, 10) && boundary <= current) ended += 1;
  }
  return ended;
}
