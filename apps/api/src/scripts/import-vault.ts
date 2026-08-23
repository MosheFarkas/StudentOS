import { eq } from 'drizzle-orm';
import { agents, user } from '@contexto/db';
import {
  Vault,
  collectClassroomSnapshot,
  collectSchoolMail,
  domainOf,
  importClassroom,
  importMail,
} from '@contexto/agent';
import type { ToolContext } from '@contexto/agent';
import { createContext } from '../context.js';
import { loadEnv } from '../env.js';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from '../google/connections.js';

/**
 * Build one student's ContextoVault from Classroom, by hand.
 *
 *   pnpm --filter @contexto/api import-vault <email>
 *
 * A script rather than a job, deliberately. Nothing reads the vault yet, so
 * there is nothing for a scheduled import to serve -- and writing a student's
 * coursework to disk is a persistence surface that should begin as somebody
 * deciding to run a command, not as a consequence of connecting Google for the
 * calendar.
 *
 * It prints what it found and what it could not reach. A school that granted
 * courses but not coursework produces a smaller vault rather than a failure,
 * and the difference should be visible rather than inferred from a thin
 * result.
 */

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: pnpm --filter @contexto/api import-vault <email>');
    process.exit(1);
  }

  const env = loadEnv();
  const ctx = createContext(env);

  const [owner] = await ctx.db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!owner) {
    console.error(`No account for ${email}`);
    process.exit(1);
  }

  const owned = await ctx.db.select().from(agents).where(eq(agents.userId, owner.id));

  const grant = await getGoogleGrant(ctx.db, owner.id);
  if (!grant.scope) {
    console.error(`${email} has not connected Google`);
    process.exit(1);
  }
  console.log(`Google scopes granted: ${grant.groups.join(', ') || '(none)'}\n`);

  const root = process.env.VAULT_ROOT ?? '/srv/contexto/vaults';

  /*
   * Collected once, per account rather than per agent.
   *
   * The Google connection belongs to the person, not to an agent, so a school
   * account with the Classroom data and no agent on it is a perfectly ordinary
   * state -- and worth being able to look at, which is why collection happens
   * whether or not there is anywhere to write the result.
   */
  const toolContext: ToolContext = {
    userId: owner.id,
    agentId: owned[0]?.id ?? 'inspection-only',
    google: new BetterAuthGoogleTokenProvider(ctx.auth, owner.id, grant.groups, grant.scope),
  };

  const { snapshot, skipped } = await collectClassroomSnapshot(toolContext);
  console.log(
    `Classroom: ${snapshot.courses.length} courses, ${snapshot.coursework.length} assignments, ` +
      `${snapshot.topics.length} topics, ${snapshot.submissions.length} submissions`,
  );
  for (const reason of skipped) console.log(`  skipped ${reason}`);
  for (const course of snapshot.courses) console.log(`  course: ${course.name}`);

  if (owned.length === 0) {
    console.log('\nNo agents on this account, so nothing was written.');
    process.exit(0);
  }

  /*
   * Mail second, and only when asked for.
   *
   * It costs a model call per message and it is the only part that puts text
   * somebody else wrote into the vault, so it is a flag rather than a default.
   */
  const wantMail = process.argv.includes('--mail');
  const domain = domainOf(owner.email);

  for (const agent of owned) {
    const vault = new Vault(root, agent.id);
    const result = await importClassroom(vault, snapshot);
    console.log(`\n--- ${agent.name} (${agent.id}) ---`);
    console.log(`Classroom: ${result.written} written, ${result.updated} updated`);

    if (wantMail) {
      if (!domain) {
        console.log('Mail: skipped, no school domain on this address');
      } else {
        const found = await collectSchoolMail(toolContext, { domain });
        for (const reason of found.skipped) console.log(`  skipped ${reason}`);
        console.log(
          `Mail: ${found.messages.length} messages from ${domain}` +
            (found.overCap > 0 ? ` (${found.overCap} more over the cap)` : ''),
        );

        const entities = (await vault.list('entity')).map((note) => note.name);
        const mail = await importMail(
          { llm: await ctx.llm.resolve(owner.id) },
          { vault, messages: found.messages, entities, userId: owner.id, domain },
        );
        console.log(
          `      ${mail.written} episodes, ${mail.people} people, ${mail.skipped} unparseable`,
        );
      }
    }

    console.log(`       ${root}/${agent.id}`);
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
