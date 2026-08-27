import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import {
  Vault,
  academicYearEnd,
  academicYearStart,
  classroomCourse,
  slugForNote,
} from '@contexto/agent';
import { createContext } from '../context.js';
import { loadEnv } from '../env.js';

/**
 * Make the courses that only their mail remembers.
 *
 *   pnpm --filter @contexto/api recover-courses <email>
 *
 * Mail already in a vault was imported when it could only link to courses that
 * already had a note, so every reference to a deleted or unreachable class was
 * dropped. Re-importing will not bring them back: it skips messages it already
 * has, by design.
 *
 * Every Classroom notification names its course in its own body, so this needs
 * nothing but the notes on disk -- no model calls, no fetching. Safe to run
 * twice.
 *
 * Bounded to the current academic year, like the importer it mirrors. A course
 * this recovers is one Classroom no longer returns, so the filter never forms a
 * verdict on it and can never drop it -- recovering last year's would put it
 * back permanently, which is the thing the filter exists to prevent.
 */
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: pnpm --filter @contexto/api recover-courses <email>');
    process.exit(1);
  }

  const env = loadEnv();
  const ctx = createContext(env);
  const [owner] = await ctx.db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!owner || !env.VAULT_ROOT) {
    console.error(`No account for ${email}, or no vault root configured.`);
    process.exit(1);
  }

  const vault = new Vault(env.VAULT_ROOT, owner.id);
  const entities = await vault.list('entity');
  const known = new Set(entities.filter((n) => n.description === 'Course').map((n) => n.name));
  const before = known.size;

  const today = new Date().toISOString().slice(0, 10);
  const since = academicYearStart(today, (await academicYearEnd(vault)) ?? '07-01');

  let linked = 0;
  let tooOld = 0;
  for (const note of await vault.list('episode')) {
    if (!/^From: .*\(Classroom\)/m.test(note.body)) continue;
    const named = classroomCourse(note.body);
    if (!named) continue;

    const slug = slugForNote(named);
    if (!known.has(slug) && (note.occurred ?? '').slice(0, 10) < since) {
      tooOld += 1;
      continue;
    }
    if (!known.has(slug)) {
      await vault.write({
        name: slug,
        kind: 'entity',
        source: 'gmail',
        description: 'Course',
        body: `${named}, on Google Classroom.\nKnown only from mail about it.`,
      });
      known.add(slug);
    }

    if (note.body.includes(`[[${slug}]]`)) continue;
    await vault.write({ ...note, body: `In [[${slug}]].\n${note.body}` });
    linked += 1;
  }

  console.log(
    `Courses: ${before} before, ${known.size} after. ${linked} episodes given a course link.` +
      (tooOld > 0 ? ` ${tooOld} left alone, from before ${since}.` : ''),
  );
}

await main();
