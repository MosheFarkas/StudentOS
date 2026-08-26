/**
 * Who teaches a course, from what they wrote in it.
 *
 * Classroom knows and will not say: userProfiles.get answers 403 without a
 * roster scope, which a school has to approve. What is left is the
 * announcements, where a teacher routinely names themselves -- "bring your
 * draft to Ms Takacs", "Mr Shaw's office hours are Tuesday".
 *
 * Measured across nineteen real courses this is sparse and noisy. It names the
 * supervisor of the Personal Project and the head of the business club, and
 * says nothing whatever about maths, English or science. So the job is not to
 * find a teacher for every course; it is to be right when it speaks and silent
 * when it cannot be, because this ends up in a document read before every
 * reply and a wrong name there is worse than no name.
 */

/** Titles a teacher is addressed by, in both languages this school uses. */
const TITLES = ['M', 'Mme', 'Mr', 'Mrs', 'Ms', 'Madame', 'Monsieur', 'Dr'];

/** One spelling per person. */
const CANONICAL: Record<string, string> = {
  M: 'M.',
  Monsieur: 'M.',
  Mme: 'Mme',
  Madame: 'Mme',
  Mr: 'Mr',
  Mrs: 'Mrs',
  Ms: 'Ms',
  Dr: 'Dr',
};

/**
 * Words that follow a title-shaped abbreviation and are not surnames.
 *
 * "M. Attached" was named the teacher of a course eight times over, because
 * every note listing a file says "Attached:" and M. is a French title. A
 * matcher that believes anything capitalised will eventually put a filename in
 * front of every conversation.
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

/** Below this it is somebody named in passing, not somebody who teaches. */
const ENOUGH_MENTIONS = 2;

/** How far ahead the leader must be to count as the answer rather than a guess. */
const CLEAR_LEAD = 2;

/**
 * The teacher, or null when the announcements will not say.
 *
 * @param announcements the text of every announcement posted to one course.
 */
export function teacherFor(announcements: readonly string[]): string | null {
  const counts = new Map<string, number>();

  for (const text of announcements) {
    for (const match of text.matchAll(MENTION)) {
      /*
       * The possessive only. "Mr Shaw's" and "Mr Shaw" are one man mentioned
       * twice; "Ms Takacs" is a surname that ends in s, and stripping that
       * turns her into Ms Takac -- a person who does not exist, named in front
       * of every conversation.
       */
      const surname = (match[2] as string).replace(/[’']s$/u, '');
      if (NOT_A_SURNAME.has(surname)) continue;

      const name = `${CANONICAL[match[1] as string] ?? match[1]} ${surname}`;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const leader = ranked[0];
  if (!leader || leader[1] < ENOUGH_MENTIONS) return null;

  /*
   * A tie is not an answer.
   *
   * Robotics named Mr Olive twice and Mr Skrovanek twice. One of them may
   * teach it and the other may run the club, and taking whichever sorted
   * first would be inventing the answer rather than finding it.
   */
  const runnerUp = ranked[1]?.[1] ?? 0;
  return leader[1] >= runnerUp * CLEAR_LEAD ? leader[0] : null;
}

/** One mail episode: who sent it, and which courses it mentions. */
export interface CourseMail {
  actor: string;
  courses: readonly string[];
}

/** Below this, somebody wrote once and is not the teacher. */
const ENOUGH_LETTERS = 3;

/** How much of a person's course mail must be about one course to count. */
const EXCLUSIVE_ENOUGH = 0.7;

/**
 * The teacher of a course, from who writes to the class about it.
 *
 * The better of the two signals, and the one that reaches the subjects. A
 * teacher writes to their own class and almost nobody else's: on a real
 * account Daniella Malka's course mail was entirely about Grade 10 Math and
 * Mrs Irwin's entirely about enriched English -- the two subjects whose
 * announcements name nobody at all.
 *
 * Exclusivity is what makes it safe. The most prolific sender on that account
 * wrote about maths, French and robotics alike, which is what an
 * administrator looks like, and taking the loudest voice per course is exactly
 * what produced a wrong teacher the first time this was attempted.
 */
export function teacherFromMail(mail: readonly CourseMail[], course: string): string | null {
  /*
   * People are counted by surname, and reported by their fullest name.
   *
   * One vault held "Sarah Mahoney" seven times and "Ms. Mahoney" four: one
   * woman who loses to nobody when counted together and to everybody when
   * counted apart.
   */
  const spread = new Map<string, { here: number; total: number; names: Map<string, number> }>();

  for (const item of mail) {
    const key = surnameOf(item.actor);
    if (!key) continue;
    const person = spread.get(key) ?? { here: 0, total: 0, names: new Map<string, number>() };
    person.total += item.courses.length;
    person.here += item.courses.filter((name) => name === course).length;
    person.names.set(item.actor, (person.names.get(item.actor) ?? 0) + 1);
    spread.set(key, person);
  }

  let best: { name: string; here: number } | null = null;
  for (const person of spread.values()) {
    if (person.here < ENOUGH_LETTERS) continue;
    if (person.here / person.total < EXCLUSIVE_ENOUGH) continue;
    if (best && person.here <= best.here) continue;

    // The fullest rendering, so "Sarah Mahoney" beats "Ms. Mahoney".
    const [fullest] = [...person.names.keys()].sort((a, b) => b.length - a.length);
    best = { name: fullest as string, here: person.here };
  }

  return best?.name ?? null;
}

/** The surname in a name, however that name was written. */
function surnameOf(actor: string): string | null {
  const words = actor
    .replace(/\b(M|Mme|Mr|Mrs|Ms|Madame|Monsieur|Dr)\.?\s+/gi, '')
    .trim()
    .split(/\s+/);
  const last = words.at(-1);
  return last && last.length > 1 ? last.toLowerCase() : null;
}
