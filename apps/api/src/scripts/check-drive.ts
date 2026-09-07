import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import {
  FALLBACK_YEAR_END,
  Vault,
  academicYearEnd,
  academicYearStart,
  collectDriveFiles,
  courseTitles,
  driveKind,
  knownFiles,
  readDriveLedger,
  standingOf,
  yearBeforeStart,
  type DriveFile,
  type DriveStanding,
  type ToolContext,
} from '@contexto/agent';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from '../google/connections.js';
import { createContext } from '../context.js';
import { loadEnv } from '../env.js';

/**
 * Show what became of every file in a student's Drive, and why.
 *
 *   pnpm --filter @contexto/api check-drive <email>
 *
 * Reads the Drive listing, the vault and the ledger of verdicts, and prints
 * where each file stands: placed by a folder, kept or refused by the
 * judgement, already Classroom's, too old, or not yet judged. Writes nothing
 * and asks no model. The judgement deletes nothing but decides what a student
 * never sees, so there has to be a way to read its mind after the fact.
 */
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: pnpm --filter @contexto/api check-drive <email>');
    process.exit(1);
  }

  const env = loadEnv();
  if (!env.VAULT_ROOT) {
    console.error('VAULT_ROOT is not set, so there is no vault to read.');
    process.exit(1);
  }

  const ctx = createContext(env);
  const [owner] = await ctx.db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!owner) {
    console.error(`No account for ${email}`);
    process.exit(1);
  }

  const grant = await getGoogleGrant(ctx.db, owner.id);
  if (!grant.scope) {
    console.error('That account has not connected Google.');
    process.exit(1);
  }

  const toolContext: ToolContext = {
    userId: owner.id,
    agentId: owner.id,
    google: new BetterAuthGoogleTokenProvider(ctx.auth, owner.id, grant.groups, grant.scope),
  };

  const vault = new Vault(env.VAULT_ROOT, owner.id);
  const [files, existing, ledger, yearEnd] = await Promise.all([
    collectDriveFiles(toolContext),
    vault.list('entity'),
    readDriveLedger(vault),
    academicYearEnd(vault),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const lastYearBegan = yearBeforeStart(academicYearStart(today, yearEnd ?? FALLBACK_YEAR_END));
  const known = knownFiles(existing);
  const courses = courseTitles(existing);
  const byId = new Map(existing.filter((note) => note.externalId).map((n) => [n.externalId, n]));

  console.log(
    `\n${files.length} files listed. Today is ${today}; nothing changed before ${lastYearBegan} is kept.\n`,
  );

  const rows = files.map((file) => ({
    file,
    standing: standingOf(file, { known, courses, lastYearBegan, ledger }),
  }));

  const label = (standing: DriveStanding, file: DriveFile): string => {
    switch (standing.why) {
      case 'folder':
        return `FOLDER    ${standing.course}`;
      case 'remembered': {
        if (!standing.verdict.keep) return 'OUT       -';
        const under = /^Part of \[\[([^\]]+)\]\]/m.exec(byId.get(file.fileId)?.body ?? '')?.[1];
        return `KEPT      ${under ?? standing.verdict.course ?? '(about school, no room)'}`;
      }
      case 'junk':
        return 'JUNK      -';
      case 'classroom':
        return 'CLASSROOM -';
      case 'too-old':
        return 'TOO OLD   -';
      case 'not-a-file':
        return 'FOLDER/SHORTCUT';
      case 'unjudged':
        return 'UNJUDGED  -';
    }
  };

  for (const { file, standing } of rows) {
    if (standing.why === 'not-a-file') continue;
    const read = byId.get(file.fileId)?.body.includes('## What is in it') ? 'read' : '';
    console.log(
      `${label(standing, file).padEnd(48)} ${file.name.slice(0, 60).padEnd(60)}  ` +
        `${driveKind(file.mimeType).padEnd(12)} ${(file.ownedByStudent ? 'theirs' : `shared by ${file.owner ?? '?'}`).padEnd(28)} ` +
        `${file.modifiedAt?.slice(0, 10) ?? '----------'}  ${read}`,
    );
  }

  const count = (test: (s: DriveStanding) => boolean) =>
    rows.filter((r) => test(r.standing)).length;
  console.log(`
Folders and shortcuts: ${count((s) => s.why === 'not-a-file')}
Classroom already had:  ${count((s) => s.why === 'classroom')}
Placed by a folder:     ${count((s) => s.why === 'folder')}
Too old to judge:       ${count((s) => s.why === 'too-old')}
Judged in, remembered:  ${count((s) => s.why === 'remembered' && s.verdict.keep)}
Judged out, remembered: ${count((s) => s.why === 'remembered' && !s.verdict.keep)}
Junk, refused outright: ${count((s) => s.why === 'junk')}
Not yet judged:         ${count((s) => s.why === 'unjudged')}`);

  const kept = rows.filter(
    ({ standing }) =>
      standing.why === 'folder' || (standing.why === 'remembered' && standing.verdict.keep),
  );
  const kinds = new Map<string, number>();
  for (const { file } of kept)
    kinds.set(driveKind(file.mimeType), (kinds.get(driveKind(file.mimeType)) ?? 0) + 1);
  console.log(
    `\nKept, by kind: ${[...kinds]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}`,
  );
  console.log(
    `Kept, theirs: ${kept.filter(({ file }) => file.ownedByStudent).length}; shared with them: ${kept.filter(({ file }) => !file.ownedByStudent).length}`,
  );
}

await main();
// The context keeps a database pool alive, and with everything printed there
// is nothing left to wait for.
process.exit(0);
