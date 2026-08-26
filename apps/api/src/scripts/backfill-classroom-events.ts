import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import { Vault, classroomEvent } from '@contexto/agent';
import { createContext } from '../context.js';
import { loadEnv } from '../env.js';

/**
 * Set the event on Classroom notifications already in a vault.
 *
 *   pnpm --filter @contexto/api backfill-classroom-events <email>
 *
 * These episodes were written before Classroom's own word for what happened
 * was being kept, so their event is whatever the summarising pass made of a
 * third-person notification -- usually "message". A re-import will not fix
 * them: it skips anything it already has, by design, and re-fetching a
 * thousand messages to change one field would spend a thousand model calls on
 * a string that is already sitting in the note.
 *
 * Deterministic, and reads nothing but the subject line the note already
 * carries. Safe to run twice.
 */
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: pnpm --filter @contexto/api backfill-classroom-events <email>');
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
  const episodes = await vault.list('episode');

  let changed = 0;
  for (const note of episodes) {
    if (!/^From: .*\(Classroom\)/m.test(note.body)) continue;
    const subject = /^Subject: (.+)$/m.exec(note.body)?.[1];
    const event = subject ? classroomEvent(subject) : null;
    if (!event || note.event === event) continue;

    await vault.write({ ...note, event });
    changed += 1;
  }

  console.log(`${episodes.length} episodes, ${changed} given Classroom's own event.`);
}

await main();
