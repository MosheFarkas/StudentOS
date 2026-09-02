import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import { createContext } from '../context.js';
import { loadEnv } from '../env.js';
import { refreshVaultFor } from '../vault-refresh.js';

/**
 * Build one student's vault, completely.
 *
 *   pnpm --filter @contexto/api build-vault <email>
 *
 * The same call the app makes when a student presses "build vault", so there
 * is one way a vault comes into existence rather than two. There used to be a
 * second: a script that fetched Classroom, fetched mail only if asked with a
 * flag, and never touched Drive or read a file at all. A vault built that way
 * was missing most of itself and looked finished, which is the worst of both.
 *
 * Everything: Classroom, school mail, Drive, the contents of every file, and
 * the document written from it. Re-running skips what is already there, so
 * this is how a vault is repaired as well as how it is made.
 */
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: pnpm --filter @contexto/api build-vault <email>');
    process.exit(1);
  }

  const env = loadEnv();
  if (!env.VAULT_ROOT) {
    console.error('VAULT_ROOT is not set, so there is nowhere to build one.');
    process.exit(1);
  }

  const ctx = createContext(env);
  const [owner] = await ctx.db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!owner) {
    console.error(`No account for ${email}`);
    process.exit(1);
  }

  console.log(`Building the vault for ${email}. This reads every file and takes hours.\n`);
  console.log(await refreshVaultFor(ctx, owner.id));
}

await main();
// The context keeps a database pool alive, and a build refused at the gate has
// nothing left to wait for -- without this it sat idle until somebody killed it.
process.exit(0);
