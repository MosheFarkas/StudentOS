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

  /*
   * Every mention, counted, rather than the newest one believed.
   *
   * Believing the newest was wrong on the first real account: a school-wide
   * orientation notice in late August named Grade 8, and that became the
   * student's year on the page read before every reply. Their own year was all
   * over the spring -- sixty mentions of Grade 10 against that one.
   *
   * Counting works because of what rolling forward does to it. A mention of
   * Grade 10 last May and one of Grade 11 last week are the same claim once
   * both are brought to today, so a student's real year accumulates from both
   * sides of the summer while a newsletter's Grade 1 and somebody else's
   * orientation stay scattered.
   */
  const votes = new Map<number, GradeReading>();
  const tally = new Map<number, number>();

  for (const note of dated) {
    const said = [...note.body.matchAll(STATED)].map((match) => Number(match[1]));

    /*
     * An episode naming several different year groups is talking to a school,
     * not about this student.
     *
     * "Grade 1 sports day, Grade 2 concert" is a newsletter. It says nothing
     * about whose inbox it landed in, and counting each of its mentions lets a
     * fortnight of them outvote the year a student is actually in.
     */
    if (new Set(said).size !== 1) continue;

    for (const stated of said) {
      const on = note.occurred as string;
      const rolledForward = yearsEndedBetween(on, today, ends);
      const grade = Math.min(stated + rolledForward, LEAVING);

      tally.set(grade, (tally.get(grade) ?? 0) + 1);
      // Episodes are newest first, so the first sighting of a grade is the most
      // recent evidence for it, which is what a reader would want quoted.
      if (!votes.has(grade)) votes.set(grade, { grade, stated, on, rolledForward });
    }
  }

  let best: GradeReading | null = null;
  let most = 0;
  for (const [grade, count] of tally) {
    // Ties go to the more recent evidence, which is the order votes was filled.
    if (count > most) {
      most = count;
      best = votes.get(grade) as GradeReading;
    }
  }

  return best;
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
