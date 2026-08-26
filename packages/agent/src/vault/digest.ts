import type { Claim } from './claims.js';
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
   * Whether the course sets work at all.
   *
   * One bit, not a count. How much work a course set was the least useful
   * thing in the first generated document and most of its length -- "science
   * and technology (61 pieces of work and 167 files/readings), extended
   * history (43 and 86)" changes nothing an agent would say. What is worth
   * knowing is whether this is a lesson or a club.
   */
  setsWork: boolean;
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
   * The last day anything happened in this course, or null.
   *
   * Half of "is this course over". A document written in August said the
   * student was preparing for an exam whose course last set work the previous
   * November, because the digest carried no time at all -- for a vault whose
   * every note is dated.
   */
  lastSeen: string | null;
  /** The last day work was due in it. The other half. */
  lastDue: string | null;
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

  const dayOf = (at: string | undefined) => (at ? at.slice(0, 10) : null);

  /*
   * The name, and whatever limits it.
   *
   * A trainee on placement teaches the class this term and not next; a
   * colleague covering one lesson teaches it on Thursday. Dropping the limit
   * to keep the shape tidy is how a document ends up stating something
   * arguable as though it were settled.
   */
  const teaches = new Map(
    claims
      .filter((c) => c.relation === 'taught by')
      .map((c) => [c.subject, c.qualifier ? `${c.object} (${c.qualifier})` : c.object]),
  );

  const assignments = entities.filter((n) => n.description === 'Assignment');
  const materials = entities.filter(
    (n) => n.description === 'Material' || n.description === 'File',
  );

  const courses: CourseDigest[] = entities
    .filter((n) => n.description === 'Course')
    .map((course) => ({
      name: course.name,
      setsWork: assignments.some(linked(course.name)),
      teacher: teaches.get(course.name) ?? null,
      lastSeen: dayOf(
        episodes
          .filter((e) => e.occurred && linked(course.name)(e))
          .map((e) => e.occurred as string)
          .sort()
          .at(-1),
      ),
      lastDue: dayOf(
        assignments
          .filter(linked(course.name))
          .map((w) => /^Due: (\S+)/m.exec(w.body)?.[1])
          .filter((at): at is string => Boolean(at))
          .sort()
          .at(-1),
      ),
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
    .map(({ name, setsWork, teacher, lastSeen, lastDue }) => ({
      name,
      setsWork,
      teacher,
      lastSeen,
      lastDue,
    }));

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
    courses,
    notes: entities.length + episodes.length,
    from: times[0]?.slice(0, 10) ?? null,
    to: times.at(-1)?.slice(0, 10) ?? null,
  };
}
