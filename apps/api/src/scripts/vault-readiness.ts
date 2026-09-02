import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import { Vault } from '@contexto/agent';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from '../google/connections.js';
import { createContext } from '../context.js';
import { loadEnv } from '../env.js';
import { checkReadiness, grantedScopes, unreadyReason } from '../vault-build.js';

/**
 * Who is ready to have a vault built, who is not, and why.
 *
 *   pnpm --filter @contexto/api vault-readiness            everyone
 *   pnpm --filter @contexto/api vault-readiness <email>    one student
 *
 * The same question the build asks itself before starting, so READY here
 * means a build would go ahead and NOT READY means it would be refused with
 * the same words. Consent is read from the stored grant. Whether Google still
 * honours it is found out by asking, which is the part no row can tell you:
 * an unpublished app's tokens die after seven days, and two testers with
 * every scope on file had empty vaults built before anyone looked.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const ctx = createContext(env);

  const only = process.argv[2];
  const students = only
    ? await ctx.db.select().from(user).where(eq(user.email, only)).limit(1)
    : await ctx.db.select().from(user).orderBy(asc(user.createdAt));
  if (only && students.length === 0) {
    console.error(`No account for ${only}`);
    process.exit(1);
  }

  for (const student of students) {
    const grant = await getGoogleGrant(ctx.db, student.id);
    const google = new BetterAuthGoogleTokenProvider(
      ctx.auth,
      student.id,
      grant.groups,
      grant.scope,
    );
    const readiness = await checkReadiness(grantedScopes(grant.scope), student.email, () =>
      google.getAccessToken('classroom'),
    );

    const consent =
      readiness.missing.length === 0 ? 'all consented' : `missing ${readiness.missing.join(', ')}`;
    const token = readiness.expired
      ? 'token refused'
      : readiness.ready
        ? 'token ok'
        : 'token not asked';

    const vault = env.VAULT_ROOT ? new Vault(env.VAULT_ROOT, student.id) : null;
    const notes = vault ? (await vault.count('entity')) + (await vault.count('episode')) : 0;
    const built = env.VAULT_ROOT ? await lastBuilt(env.VAULT_ROOT, student.id) : null;
    const off = grant.disabled.length > 0 ? `, off: ${grant.disabled.join(' ')}` : '';

    console.log(
      `${readiness.ready ? 'READY    ' : 'NOT READY'}  ${student.email.padEnd(30)}  ` +
        `${consent.padEnd(28)}  ${token.padEnd(15)}  ` +
        `${notes} notes${built ? `, built ${built}` : ''}${off}` +
        `${readiness.ready ? '' : `  -- ${unreadyReason(readiness)}`}`,
    );
  }

  // The context keeps a database pool and timers alive; nothing left to wait for.
  process.exit(0);
}

/** When user.md was last written, which every build and refresh ends with. */
async function lastBuilt(root: string, userId: string): Promise<string | null> {
  try {
    const { mtime } = await stat(join(root, userId, 'docs', 'user.md'));
    return mtime.toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return null;
  }
}

await main();
