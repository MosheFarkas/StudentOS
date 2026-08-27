import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import { Vault, discoverSchoolDomains, writeSchoolDoc, type ToolContext } from '@contexto/agent';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from '../google/connections.js';
import { createContext } from '../context.js';
import { loadEnv } from '../env.js';

/**
 * Research one student's school, and write the page about it.
 *
 *   pnpm --filter @contexto/api research-school <email>
 *
 * Deliberately not part of a build. This is the one pass in the product that
 * reaches the open web, searches are billed one at a time, and a school's
 * calendar does not change between Tuesdays -- so it is asked for rather than
 * run every six hours alongside everything else.
 *
 * What it establishes about the academic year is read back by the pass that
 * decides which of a student's classes are current. Until this has run at least
 * once, that pass falls back to assuming the year ends on the 1st of July.
 */
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: pnpm --filter @contexto/api research-school <email>');
    process.exit(1);
  }

  const env = loadEnv();
  if (!env.VAULT_ROOT) {
    console.error('VAULT_ROOT is not set, so there is no vault to write into.');
    process.exit(1);
  }

  const ctx = createContext(env);
  const [owner] = await ctx.db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!owner) {
    console.error(`No account for ${email}`);
    process.exit(1);
  }

  const vault = new Vault(env.VAULT_ROOT, owner.id);
  if (!(await vault.has())) {
    console.error('That vault is empty. Build it first, so there is something to research from.');
    process.exit(1);
  }

  /*
   * The domains their school mails from, rediscovered rather than cached.
   *
   * The one hard fact in the vault that identifies the school at all, and the
   * only thing separating "research this school" from "research a school with
   * a name like this one".
   */
  const grant = await getGoogleGrant(ctx.db, owner.id);
  let domains: string[] = [];
  if (grant.scope) {
    const toolContext: ToolContext = {
      userId: owner.id,
      agentId: owner.id,
      google: new BetterAuthGoogleTokenProvider(ctx.auth, owner.id, grant.groups, grant.scope),
    };
    domains = await discoverSchoolDomains(toolContext, owner.email);
  }

  console.log(`Researching the school behind ${domains.join(', ') || email}.\n`);

  const result = await writeSchoolDoc(
    { llm: await ctx.llm.resolve(owner.id) },
    { vault, userId: owner.id, ...(domains.length > 0 ? { domains } : {}) },
  );

  if (!result.written) {
    console.error('Nothing was written. The page, if there was one, is unchanged.');
    process.exit(1);
  }

  console.log(
    result.yearEnds
      ? `Wrote school.md. The academic year ends on ${result.yearEnds}.`
      : 'Wrote school.md. The academic year end could not be established, so the ' +
          'course filter will keep assuming the 1st of July.',
  );
}

await main();
