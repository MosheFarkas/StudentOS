import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import { Vault, domainOf, readUserDoc, writeUserDoc } from '@contexto/agent';
import { createContext } from '../context.js';
import { loadEnv } from '../env.js';

/**
 * Rewrite one student's user.md from the vault they already have.
 *
 *   pnpm --filter @contexto/api write-user-doc <email>
 *
 * The document is normally written at the end of a refresh, which imports
 * everything first and takes hours. Nothing about it depends on that import
 * having just happened -- it reads the vault, not Google -- so re-deriving it
 * after a change to how the vault is understood should not cost a re-import of
 * a mailbox that has not changed.
 *
 * It prints the old document beside the new one, because the interesting thing
 * about a rewrite is what moved.
 */
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: pnpm --filter @contexto/api write-user-doc <email>');
    process.exit(1);
  }

  const env = loadEnv();
  const ctx = createContext(env);

  const [owner] = await ctx.db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!owner) {
    console.error(`No account for ${email}`);
    process.exit(1);
  }
  if (!env.VAULT_ROOT) {
    console.error('VAULT_ROOT is not set, so there is no vault to read.');
    process.exit(1);
  }

  const vault = new Vault(env.VAULT_ROOT, owner.id);
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);
  console.log(`Vault: ${entities.length} entities, ${episodes.length} episodes\n`);

  const before = await readUserDoc(vault);
  console.log(`--- before ---\n${before ?? '(nothing was ever written)'}\n`);

  const llm = await ctx.llm.resolve(owner.id);

  const started = Date.now();
  const after = await writeUserDoc(
    { llm },
    {
      vault,
      userId: owner.id,
      ...(owner.name ? { name: owner.name } : {}),
      ...(domainOf(owner.email) ? { schoolDomains: [domainOf(owner.email) as string] } : {}),
    },
  );

  console.log(`--- after (${Math.round((Date.now() - started) / 1000)}s) ---`);
  console.log(after ?? '(nothing written: the vault has no courses)');
}

await main();
