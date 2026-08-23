import { eq } from 'drizzle-orm';
import { agents, user } from '@contexto/db';
import { Vault, collectClassroomSnapshot, importClassroom } from '@contexto/agent';
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
  if (owned.length === 0) {
    console.error(`${email} has no agents`);
    process.exit(1);
  }

  const grant = await getGoogleGrant(ctx.db, owner.id);
  if (!grant.scope) {
    console.error(`${email} has not connected Google`);
    process.exit(1);
  }
  console.log(`Google scopes granted: ${grant.groups.join(', ') || '(none)'}\n`);

  const root = process.env.VAULT_ROOT ?? '/srv/contexto/vaults';

  for (const agent of owned) {
    console.log(`--- ${agent.name} (${agent.id}) ---`);

    const toolContext: ToolContext = {
      userId: owner.id,
      agentId: agent.id,
      google: new BetterAuthGoogleTokenProvider(ctx.auth, owner.id, grant.groups, grant.scope),
    };

    const { snapshot, skipped } = await collectClassroomSnapshot(toolContext);
    console.log(
      `Classroom: ${snapshot.courses.length} courses, ${snapshot.coursework.length} assignments, ` +
        `${snapshot.topics.length} topics, ${snapshot.submissions.length} submissions`,
    );
    for (const reason of skipped) console.log(`  skipped ${reason}`);

    const result = await importClassroom(new Vault(root, agent.id), snapshot);
    console.log(`Vault: ${result.written} notes written, ${result.updated} updated`);
    console.log(`       ${root}/${agent.id}\n`);
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
