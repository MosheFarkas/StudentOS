import { findTeacher, namesPostedIn } from './teachers.js';
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
   * Who teaches it, when the course's own announcements say so clearly.
   *
   * Null far more often than not: on a real account this names the Personal
   * Project supervisor and the head of the business club, and knows nothing
   * about maths, English or science. Silence is the right answer there --
   * Classroom knows and will not say without a roster scope. See teachers.ts.
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

export async function vaultDigest(vault: Vault, studentDomain?: string): Promise<VaultDigest> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);

  const linked = (name: string) => (note: { body: string }) => note.body.includes(`[[${name}]]`);

  /*
   * Who is staff and who is a classmate.
   *
   * The school puts students on one mail domain and staff on another, and
   * every Person note carries the address it was created from. Without this
   * the maths teacher lost to a classmate: she wrote only about maths, he also
   * coached robotics, and a rule that rewarded devotion to one subject picked
   * her.
   */
  const staffSurnames = new Set(
    entities
      .filter((n) => n.description === 'Person' && n.externalId)
      .filter((n) => !studentDomain || !n.externalId!.endsWith(`@${studentDomain}`))
      .map((n) => n.name.split('-').at(-1) as string),
  );
  const isStaff = (actor: string) => {
    const surname = actor.trim().split(/\s+/).at(-1)?.toLowerCase() ?? '';
    return staffSurnames.has(surname);
  };

  const dayOf = (at: string | undefined) => (at ? at.slice(0, 10) : null);

  /** Staff who have written to the class about one course, with how often. */
  const staffWritersFor = (course: string) => {
    const letters = new Map<string, number>();
    for (const episode of episodes) {
      if (!episode.actor || !episode.body.includes(`[[${course}]]`)) continue;
      if (!isStaff(episode.actor)) continue;
      letters.set(episode.actor, (letters.get(episode.actor) ?? 0) + 1);
    }
    return [...letters].map(([name, count]) => ({ name, letters: count }));
  };
  const assignments = entities.filter((n) => n.description === 'Assignment');
  const materials = entities.filter(
    (n) => n.description === 'Material' || n.description === 'File',
  );

  const courses: CourseDigest[] = entities
    .filter((n) => n.description === 'Course')
    .map((course) => ({
      name: course.name,
      setsWork: assignments.some(linked(course.name)),
      /*
       * Two independent readings, and either will do.
       *
       * The announcements name a teacher for four courses of nineteen and
       * know nothing of maths, English or science; who writes to the class
       * reaches exactly those. Preferring the announcement is arbitrary but
       * harmless -- both are evidence about the same course, and neither
       * fires without a clear lead.
       */
      teacher: findTeacher({
        postedNames: namesPostedIn(
          episodes
            .filter((e) => e.source === 'classroom' && e.body.includes(`[[${course.name}]]`))
            .map((e) => e.body),
        ),
        staffMail: staffWritersFor(course.name),
      }),
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
