import {
  askWhatKindOfThing,
  askWhatSchoolThisIs,
  askWhatTheyDo,
  askWhatYearTheyAreIn,
  askWhetherItIsRunning,
  askWhoTeaches,
  staffRoster,
  type AskContext,
} from './evidence.js';
import type { Question } from './interpret.js';
import type { Vault } from './vault.js';

/**
 * Everything the vault works out about itself, and the order it works it out.
 *
 * Adding a kind of understanding should be adding an entry here, not another
 * branch in the pass that runs them. Each one says what it is asking, what it
 * asks about, and whether the question has one answer; the machinery that
 * proposes, refutes, checks and settles is the same for all of them, which is
 * the only reason a new one can be trusted on the day it is written.
 *
 * The order is not decoration. Every question sees what the ones above it
 * settled, and most of the accuracy in this file is in that arrangement rather
 * than in any single question:
 *
 *   - What somebody IS comes before what they DID. A head of year setting
 *     deadlines and a history teacher setting deadlines are indistinguishable
 *     inside one course, and the sentence that separates them lives in a note
 *     about a different class.
 *   - What a course IS comes before who teaches it. Nobody teaches a house,
 *     and a question that cannot be asked cannot be answered wrongly.
 *   - Whether it is RUNNING comes last of the course questions, because it is
 *     the only one that gains nothing from the others and the only one that
 *     needs a clock.
 *   - Which YEAR they are in and which SCHOOL they go to stand apart: they are
 *     about the student rather than about anything the vault holds a note for,
 *     and every other question is indifferent to both.
 *
 * Nothing here reaches for a fixed vocabulary of relations. "taught by",
 * "works at the school as" and "is" are the questions worth asking today, not
 * a schema of the ways two things at a school can be related -- there is a
 * house, a form tutor and a placement student in this data alone, and any list
 * written in advance would have flattened them into whichever word fitted
 * worst.
 */

export interface Inquiry {
  /** How the answer relates to the subject, in open words. */
  relation: string;
  /** Whether a subject may have only one answer, for settling. */
  single: boolean;
  /** The notes worth asking about. */
  subjects(vault: Vault, context: AskContext): Promise<string[]>;
  /** The question, or null when there is nothing worth asking. */
  ask(vault: Vault, subject: string, context: AskContext): Promise<Question | null>;
}

const coursesIn = async (vault: Vault): Promise<string[]> =>
  (await vault.list('entity')).filter((n) => n.description === 'Course').map((n) => n.name);

export const INQUIRIES: Inquiry[] = [
  {
    relation: 'works at the school as',
    single: true,
    subjects: async (vault, { studentDomain }) =>
      (await staffRoster(vault, studentDomain)).map((p) => p.note),
    ask: askWhatTheyDo,
  },
  {
    relation: 'is',
    single: true,
    subjects: coursesIn,
    ask: askWhatKindOfThing,
  },
  {
    relation: 'taught by',
    /*
     * Many, because co-teaching is ordinary.
     *
     * This was declared to hold one answer, so a class taught by two people
     * read as a contest and a contest withholds -- and the vault said nothing
     * whatever about who taught French, whose two teachers both post its work
     * and both mark it. The shape was turning the commonest arrangement in a
     * school into silence.
     *
     * The margin rules that stopped the wrong French teacher are still there;
     * they apply between rival readings of one slot, and two people who both
     * teach a class are not rivals.
     */
    single: false,
    subjects: coursesIn,
    ask: askWhoTeaches,
  },
  {
    relation: 'is currently',
    single: true,
    subjects: coursesIn,
    ask: askWhetherItIsRunning,
  },
  {
    relation: 'is in',
    single: true,
    /*
     * One subject, and not a note.
     *
     * Everything else here is about something the vault holds a note for. This
     * is about the person the vault is for, who has no note of their own --
     * they are the one thing every note is already about.
     */
    subjects: async () => [THE_STUDENT],
    ask: askWhatYearTheyAreIn,
  },
  {
    relation: 'goes to',
    single: true,
    subjects: async () => [THE_STUDENT],
    ask: askWhatSchoolThisIs,
  },
];

/** The student themselves, as a subject a claim can be about. */
export const THE_STUDENT = 'the-student';
