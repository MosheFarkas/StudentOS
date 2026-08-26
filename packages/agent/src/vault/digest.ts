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
}

export interface VaultDigest {
  courses: CourseDigest[];
  /** Everything in the vault, so the writer knows how much it is speaking for. */
  notes: number;
  /** The span the vault covers, as dates, or null when nothing is dated. */
  from: string | null;
  to: string | null;
}

export async function vaultDigest(vault: Vault): Promise<VaultDigest> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  const linked = (name: string) => (note: { body: string }) => note.body.includes(`[[${name}]]`);
  const assignments = entities.filter((n) => n.description === 'Assignment');
  const materials = entities.filter(
    (n) => n.description === 'Material' || n.description === 'File',
  );

  const courses: CourseDigest[] = entities
    .filter((n) => n.description === 'Course')
    .map((course) => ({
      name: course.name,
      setsWork: assignments.some(linked(course.name)),
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
    .map(({ name, setsWork }) => ({ name, setsWork }));

  const times = episodes
    .map((e) => e.occurred)
    .filter((at): at is string => typeof at === 'string')
    .sort();

  /*
   * No people, and above all no teachers.
   *
   * Mail is the only source of a name here, and somebody writing about a
   * course is not its teacher. On a real account the top correspondent for
   * maths, French and robotics was the same man, and the top name for English
   * was not the English teacher. Handing the writer a list of courses beside a
   * list of people got exactly what anyone would expect: it paired them,
   * confidently, and put a wrong teacher into every conversation that student
   * would ever have.
   *
   * Naming teachers needs classroom.rosters.readonly, which a school has to
   * approve. Until then the honest offer is nothing rather than a guess.
   */
  return {
    courses,
    notes: entities.length + episodes.length,
    from: times[0]?.slice(0, 10) ?? null,
    to: times.at(-1)?.slice(0, 10) ?? null,
  };
}
