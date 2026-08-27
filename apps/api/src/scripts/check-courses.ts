import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
import {
  Vault,
  academicYearEnd,
  classifyCourses,
  collectClassroomSnapshot,
  describeCourses,
  type ToolContext,
} from '@contexto/agent';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from '../google/connections.js';
import { createContext } from '../context.js';
import { loadEnv } from '../env.js';

/**
 * Show what the course filter would decide, without deciding it.
 *
 *   pnpm --filter @contexto/api check-courses <email>
 *
 * Reads Classroom, asks the classifier, prints the verdicts, and writes nothing
 * anywhere. The filter it is checking deletes notes, and it has already misread
 * an advisory group as a taught subject on this account -- so there needs to be
 * a way to see what it thinks that does not involve finding out afterwards.
 *
 * Run this before a build whenever the classifier or its prompt changes.
 */
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: pnpm --filter @contexto/api check-courses <email>');
    process.exit(1);
  }

  const env = loadEnv();
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

  const { snapshot, skipped } = await collectClassroomSnapshot(toolContext);
  for (const missing of skipped) console.warn(`skipped: ${missing}`);

  // The researched calendar where there is a vault to have researched one.
  const yearEnd = env.VAULT_ROOT
    ? await academicYearEnd(new Vault(env.VAULT_ROOT, owner.id))
    : null;

  const today = new Date().toISOString().slice(0, 10);
  const described = describeCourses(snapshot, today);
  const verdicts = await classifyCourses(
    { llm: await ctx.llm.resolve(owner.id) },
    { courses: described, today, ...(yearEnd ? { yearEnd } : {}), userId: owner.id },
  );

  console.log(
    `\n${snapshot.courses.length} courses. Today is ${today}; the year ends ` +
      `${yearEnd ?? '07-01 (nothing has researched the real date)'}.\n`,
  );

  const width = Math.max(...verdicts.map((v) => v.course.length), 6);
  for (const verdict of verdicts) {
    const about = described.find((course) => course.name === verdict.course);
    console.log(
      `${verdict.keep ? 'KEEP ' : 'DROP '} ${verdict.course.padEnd(width)}  ` +
        `${verdict.academic ? 'subject   ' : 'not-taught'}  ` +
        `${verdict.subject.padEnd(16)}  ${verdict.year ?? '----'}  ` +
        `${about?.workCount ?? 0} pieces of work, ${about?.graded ? 'marked' : 'unmarked'}` +
        `${about?.lastActivity ? `, last ${about.lastActivity}` : ', undated'}` +
        `${about?.courseState === 'ARCHIVED' ? ', archived' : ''}`,
    );
  }

  const dropped = verdicts.filter((v) => !v.keep);
  console.log(`\n${dropped.length} of ${verdicts.length} would be dropped. Nothing was changed.`);
}

await main();
