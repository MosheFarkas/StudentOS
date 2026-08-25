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
  /** How much work the course has set. */
  assignments: number;
  /** How much of it carries a mark. */
  marked: number;
  /**
   * How much has no submission on record.
   *
   * About the record, not the student: Classroom leaves work in that state
   * unless somebody presses a button, and many teachers never ask. The writer
   * is told this in so many words, because the number invites a verdict.
   */
  noSubmission: number;
  /** Files, readings and slide decks filed under it. */
  materials: number;
}

export interface PersonDigest {
  name: string;
  messages: number;
}

export interface VaultDigest {
  courses: CourseDigest[];
  people: PersonDigest[];
  /** Everything in the vault, so the writer knows how much it is speaking for. */
  notes: number;
  /** The span the vault covers, as dates, or null when nothing is dated. */
  from: string | null;
  to: string | null;
}

/** People worth naming. Below this it is somebody who mailed once. */
const ENOUGH_MESSAGES = 2;
const MOST_PEOPLE = 12;

export async function vaultDigest(vault: Vault): Promise<VaultDigest> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  const linked = (name: string) => (note: { body: string }) => note.body.includes(`[[${name}]]`);
  const assignments = entities.filter((n) => n.description === 'Assignment');
  const materials = entities.filter(
    (n) => n.description === 'Material' || n.description === 'File',
  );

  const courses: CourseDigest[] = entities
    .filter((n) => n.description === 'Course')
    .map((course) => {
      const work = assignments.filter(linked(course.name));
      return {
        name: course.name,
        assignments: work.length,
        marked: work.filter((w) => /Marked /.test(w.body)).length,
        noSubmission: work.filter((w) => /No submission recorded/i.test(w.body)).length,
        materials: materials.filter(linked(course.name)).length,
      };
    })
    /*
     * A course nothing has ever happened in is a shell -- a club that was
     * created and never used -- and inside a budget this tight it crowds out
     * one the student actually attends.
     */
    .filter((c) => c.assignments > 0 || c.materials > 0)
    .sort((a, b) => b.assignments + b.materials - (a.assignments + a.materials));

  const wrote = new Map<string, number>();
  for (const episode of episodes) {
    if (!episode.actor) continue;
    wrote.set(episode.actor, (wrote.get(episode.actor) ?? 0) + 1);
  }

  const people: PersonDigest[] = [...wrote.entries()]
    .filter(([, messages]) => messages >= ENOUGH_MESSAGES)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MOST_PEOPLE)
    .map(([name, messages]) => ({ name, messages }));

  const times = episodes
    .map((e) => e.occurred)
    .filter((at): at is string => typeof at === 'string')
    .sort();

  return {
    courses,
    people,
    notes: entities.length + episodes.length,
    from: times[0]?.slice(0, 10) ?? null,
    to: times.at(-1)?.slice(0, 10) ?? null,
  };
}
