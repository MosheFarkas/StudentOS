/**
 * Who teaches a course.
 *
 * Classroom knows and will not say: userProfiles.get answers 403 without a
 * roster scope, which a school has to approve. Two things in the vault answer
 * it instead, and neither alone is enough.
 *
 * The school puts students on one mail domain and staff on another. That is
 * the fact everything here rests on, and missing it cost the first two
 * attempts: a classmate who emailed only ever about maths looked exactly like
 * devotion to one subject, and the actual maths teacher was thrown out for
 * also coaching robotics.
 *
 * With students gone, whoever writes to a class about it is usually its
 * teacher -- but not always, because a year head writes to every class he
 * looks after. So where a course's own announcements name somebody, the
 * teacher has to be one of those names. That is what keeps the year head out
 * of French, where the announcements name two other people and never him.
 */

/** Someone on the staff domain who has written about a course. */
export interface StaffWriter {
  name: string;
  /** How many pieces of mail about this course they sent. */
  letters: number;
}

export interface TeacherEvidence {
  /** Names appearing in this course's own announcements. */
  postedNames: readonly string[];
  /** Staff who have written to the class about it, busiest first or not. */
  staffMail: readonly StaffWriter[];
}

/** How far ahead one writer must be to beat another rather than tie with them. */
const CLEAR_LEAD = 2;

/**
 * The teacher, or null when the evidence will not say.
 *
 * Null is a perfectly good answer and by far the most common one. A wrong name
 * here sits in front of every conversation the student ever has, and there is
 * no version of that which is better than saying nothing.
 */
export function findTeacher({ postedNames, staffMail }: TeacherEvidence): string | null {
  if (staffMail.length === 0) return null;

  /*
   * Where the course posts announcements naming people, the teacher is one of
   * them. Somebody who writes a lot of mail about a class but never posts in
   * it is running something around the class, not teaching it.
   */
  const candidates =
    postedNames.length > 0
      ? staffMail.filter((writer) => postedNames.some((posted) => sameSurname(posted, writer.name)))
      : [...staffMail];

  if (candidates.length === 0) return null;

  const ranked = [...candidates].sort((a, b) => b.letters - a.letters);
  const leader = ranked[0] as StaffWriter;
  const runnerUp = ranked[1]?.letters ?? 0;

  // One candidate needs no lead. Several need a decisive one, because picking
  // between two equals is inventing an answer rather than finding it.
  if (ranked.length > 1 && leader.letters < runnerUp * CLEAR_LEAD) return null;
  return leader.name;
}

/** Whether two renderings of a name are the same person. */
function sameSurname(a: string, b: string): boolean {
  const surname = (name: string) =>
    name
      .replace(/\b(M|Mme|Mr|Mrs|Ms|Madame|Monsieur|Dr)\.?\s*/gi, '')
      .trim()
      .split(/\s+/)
      .at(-1)
      ?.replace(/[’']s$/u, '')
      .toLowerCase() ?? '';

  const left = surname(a);
  return left !== '' && left === surname(b);
}

/** Titles a teacher is addressed by, in both languages this school uses. */
const TITLES = ['M', 'Mme', 'Mr', 'Mrs', 'Ms', 'Madame', 'Monsieur', 'Dr'];

/**
 * Words that follow a title-shaped abbreviation and are not surnames.
 *
 * "M. Attached" was named the teacher of a course eight times over, because
 * every note listing a file says "Attached:" and M. is a French title.
 */
const NOT_A_SURNAME = new Set([
  'Attached',
  'A',
  'The',
  'This',
  'That',
  'It',
  'If',
  'In',
  'On',
  'At',
  'To',
  'For',
  'From',
  'And',
  'But',
  'Please',
  'Bring',
  'See',
  'Note',
  'Due',
  'Merci',
  'Bonjour',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]);

const MENTION = new RegExp(
  String.raw`\b(${TITLES.join('|')})\.?\s+([A-ZÀ-Ü][A-Za-zÀ-ÿ'’-]{1,})`,
  'g',
);

/** Every person named in a course's announcements, however often. */
export function namesPostedIn(announcements: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of announcements) {
    for (const match of text.matchAll(MENTION)) {
      const surname = (match[2] as string).replace(/[’']s$/u, '');
      if (NOT_A_SURNAME.has(surname)) continue;
      found.add(`${match[1]} ${surname}`);
    }
  }
  return [...found];
}
