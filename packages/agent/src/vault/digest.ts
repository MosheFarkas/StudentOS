import type { Claim } from './claims.js';
import { THE_STUDENT } from './inquiries.js';
import type { Vault } from './vault.js';

/**
 * The vault, counted, for the pass that writes about the student.
 *
 * Not the vault itself: three and a half thousand notes will not fit in a
 * prompt, and would cost a fortune on every rebuild if they did. Everything
 * countable is counted here, where counting is free and exact, and the model
 * is left to do the one thing only it can -- turn a table into a sentence
 * somebody would actually say.
 *
 * The shape is deliberately flat and small. A writer given more structure than
 * this starts describing the structure.
 */

export interface CourseDigest {
  name: string;
  /**
   * What the school calls it, as somebody typed it into Classroom.
   *
   * Not inferred. The document used to list courses by slug and leave the
   * writer to turn "grade-10-math-2025-2026" back into something a person
   * would say -- inference with no evidence, done in the pass with the least
   * room to do it. The name was written down all along.
   */
  title: string;
  /**
   * What kind of thing it is: a subject, a club, a house, a noticeboard.
   *
   * Everything arrives from Google Classroom as a "course", and the digest
   * used to guess between them from whether any work had ever been set. That
   * bit was wrong in both directions -- a club that once posted a form sets
   * work, and a subject marked entirely on paper does not -- and it was the
   * writer, not the digest, that had to make something of it.
   */
  kind: string | null;
  /**
   * Who teaches it, when a claim about that survived being challenged.
   *
   * Read here, never worked out here. Three earlier versions each tried to
   * derive this from co-occurrence -- who writes the most mail, who is named
   * exclusively, who is named at all -- and each produced a confident wrong
   * name, because a count over fragments cannot tell teaching from any other
   * reason to write to a class. Null far more often than not, which is the
   * honest answer: Classroom knows and will not say without a roster scope.
   */
  teacher: string | null;
  /**
   * Whether it is running, finished, or has not started.
   *
   * Also read rather than derived. The digest used to hand over the last date
   * anything happened and the last deadline it set, and leave the writer to
   * work out where in a school year that put it -- which is a judgement about
   * term dates and holidays, made in a pass that had no room for it. A
   * document written in late August had a student preparing for an exam sat
   * the previous November.
   */
  state: string | null;
}

export interface VaultDigest {
  /**
   * Today, as the vault sees it.
   *
   * A model has no clock. Told only that a course last ran in June, it cannot
   * tell whether that was last week or last year, and it wrote the summer
   * holidays as though term were still running.
   */
  today: string;
  /**
   * Which year at school they are in, when a claim about it survived.
   *
   * The first sentence of the document written from this is their name, their
   * year and their school, and the year used to be read off a course slug by a
   * writer with no evidence and no way to decline.
   */
  year: string | null;
  /**
   * The school, when a claim about it survived.
   *
   * Read out of what people wrote rather than recognised from a mail domain.
   * Recognising a domain is recall, not reading, and a school named from
   * memory has no evidence behind it and cannot be checked by anybody.
   */
  school: string | null;
  courses: CourseDigest[];
  /** Everything in the vault, so the writer knows how much it is speaking for. */
  notes: number;
  /** The span the vault covers, as dates, or null when nothing is dated. */
  from: string | null;
  to: string | null;
}

export async function vaultDigest(
  vault: Vault,
  /**
   * What the interpretation pass settled on, if it has run.
   *
   * Claims come in already challenged and already reconciled. Nothing in this
   * file re-reads the evidence behind them, which is the point: a second
   * reader forming its own opinion from the same fragments is how one vault
   * ended up with three different answers to the same question.
   */
  claims: readonly Claim[] = [],
): Promise<VaultDigest> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  const linked = (name: string) => (note: { body: string }) => note.body.includes(`[[${name}]]`);

  /**
   * A settled claim's object, with whatever limits it.
   *
   * A trainee on placement teaches the class this term and not next; a
   * colleague covering one lesson teaches it on Thursday. Dropping the limit
   * to keep the shape tidy is how a document ends up stating something
   * arguable as though it were settled.
   */
  const answers = (relation: string) =>
    new Map(
      claims
        .filter((c) => c.relation === relation)
        .map((c) => [c.subject, c.qualifier ? `${c.object} (${c.qualifier})` : c.object]),
    );

  const teaches = answers('taught by');
  const kinds = answers('is');
  const states = answers('is currently');

  const assignments = entities.filter((n) => n.description === 'Assignment');
  const materials = entities.filter(
    (n) => n.description === 'Material' || n.description === 'File',
  );

  const courses: CourseDigest[] = entities
    .filter((n) => n.description === 'Course')
    .map((course) => ({
      name: course.name,
      title: (course.body.split('\n')[0] ?? '').split(',')[0]?.trim() || course.name,
      kind: kinds.get(course.name) ?? null,
      teacher: teaches.get(course.name) ?? null,
      state: states.get(course.name) ?? null,
      // Used only to tell a real course from an empty shell, then dropped. It
      // never reaches the writer.
      weight:
        assignments.filter(linked(course.name)).length +
        materials.filter(linked(course.name)).length,
    }))
    /*
     * A course nothing has ever happened in is a shell -- a club that was
     * created and never used -- and inside a budget this tight it crowds out
     * one the student actually attends.
     */
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map(({ name, title, kind, teacher, state }) => ({ name, title, kind, teacher, state }));

  const times = episodes
    .map((e) => e.occurred)
    .filter((at): at is string => typeof at === 'string')
    .sort();

  /*
   * No list of people, still.
   *
   * A teacher is attached to the course they teach or to nothing at all --
   * see teachers.ts. Handing the writer a loose list of everyone who has ever
   * emailed is what produced an invented teacher the first time: it paired
   * that list with the course list, confidently and wrongly.
   */
  return {
    today: new Date().toISOString().slice(0, 10),
    year: answers('is in').get(THE_STUDENT) ?? null,
    school: answers('goes to').get(THE_STUDENT) ?? null,
    courses,
    notes: entities.length + episodes.length,
    from: times[0]?.slice(0, 10) ?? null,
    to: times.at(-1)?.slice(0, 10) ?? null,
  };
}
