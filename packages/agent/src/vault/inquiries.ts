import {
  askWhatKindOfThing,
  askWhatTheyDo,
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
 *   - Whether it is RUNNING comes last, because it is the only one that gains
 *     nothing from the others and the only one that needs a clock.
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
    single: true,
    subjects: coursesIn,
    ask: askWhoTeaches,
  },
  {
    relation: 'is currently',
    single: true,
    subjects: coursesIn,
    ask: askWhetherItIsRunning,
  },
];
