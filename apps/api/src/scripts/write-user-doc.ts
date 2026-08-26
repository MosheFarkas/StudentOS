import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import {
  Vault,
  domainOf,
  readUserDoc,
  understandVault,
  vaultDigest,
  writeUserDoc,
} from '@contexto/agent';
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

  /*
   * What the vault settled on, before the writer turns it into prose.
   *
   * A document that reads badly can be a bad writer or a bad understanding,
   * and from the outside those look identical. Printing the claims separates
   * them: a course missing here was never found, and a course present here and
   * absent from the document was dropped by the writer.
   */
  const llm = await ctx.llm.resolve(owner.id);
  const { settled, withheld } = await understandVault({ llm }, vault, {
    userId: owner.id,
    ...(domainOf(owner.email) ? { studentDomain: domainOf(owner.email) as string } : {}),
    today: new Date().toISOString().slice(0, 10),
  });
  const digest = await vaultDigest(vault, settled);

  console.log(`--- what the vault settled (${settled.length} claims) ---`);
  console.log(`student: ${digest.year ?? 'year unknown'}, ${digest.school ?? 'school unknown'}\n`);
  for (const c of digest.courses) {
    console.log(
      `  ${c.title}\n    kind=${c.kind ?? '?'}  teacher=${c.teacher ?? '?'}  state=${c.state ?? '?'}`,
    );
  }
  console.log(`\n--- withheld (${withheld.length}) ---`);
  for (const w of withheld.slice(0, 20)) {
    console.log(`  ${w.claim.subject} ${w.claim.relation} ${w.claim.object} -> ${w.reason}`);
  }
  console.log('');

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
