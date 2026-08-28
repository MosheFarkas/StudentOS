import { eq } from 'drizzle-orm';
import { agents, user } from '@contexto/db';
import {
  Vault,
  collectClassroomSnapshot,
  collectSchoolMail,
  discoverSchoolDomains,
  readFileContents,
  writeUserDoc,
  collectDriveFiles,
  importDrive,
  domainOf,
  importClassroom,
  importMail,
  classifyCourses,
  academicYearEnd,
  readDocument,
  SCHOOL_DOC_NAME,
  academicYearStart,
  FALLBACK_YEAR_END,
  describeCourses,
  filterSnapshot,
  writeClassDocs,
  writePersonDocs,
  ensureChatsDoc,
  sweepDroppedCourses,
  sweepCourseMail,
  sweepUnattachedFiles,
  readDriveFile,
  textFromDriveRead,
} from '@contexto/agent';
import type { ToolContext } from '@contexto/agent';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from './google/connections.js';
import type { AppContext } from './context.js';
import { reportProgress, type BuildPhase } from './vault-build.js';

/**
 * Keeping ContextoVault current.
 *
 * Here rather than in the worker for one reason: refreshing needs a Google
 * access token, and getting one means going through Better Auth, which lives in
 * this app. The worker has a database and no credentials. Duplicating the auth
 * configuration into a second process to avoid a timer in this one would be
 * trading a small oddity for a real source of drift.
 *
 * A vault that is never refreshed is worse than no vault: it answers questions
 * about a deadline that moved last month with the date from the month before,
 * confidently, because a copy has no way to know it is old.
 */

/** How often to look. School data changes on the scale of days, not minutes. */
const EVERY = 6 * 60 * 60 * 1000;

/** Agents refreshed per pass, so one wake cannot run for an hour. */
const BATCH = 5;

/**
 * The students to refresh this pass, from a listing of their agents.
 *
 * The vault used to belong to an agent, so this loop was over agents. It
 * belongs to the student now, and iterating agents breaks at both ends: a
 * student with three agents had their whole year imported three times every
 * pass, and a student with none was never refreshed at all -- while their
 * vault, three and a half thousand notes of it, sat there going stale.
 *
 * Both cases are real. The account this was built against has no agents left
 * and the largest vault on the deployment.
 */
export function studentsToRefresh(
  rows: readonly { userId: string; agentId: string | null }[],
  batch: number,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.size >= batch && !seen.has(row.userId)) break;
    seen.add(row.userId);
  }
  return [...seen];
}

/**
 * Import everything for one student.
 *
 * Exported so the "build vault" button runs exactly what the timer runs, and
 * the two cannot drift into doing different things.
 */
export async function refreshVaultFor(ctx: AppContext, userId: string): Promise<string> {
  // Only a build reports progress; the timer has nobody watching it.
  /*
   * Everything, because somebody asked for it.
   *
   * The per-pass cap on file reading exists to stop a background timer
   * spending hours nobody requested. A student pressing "build vault" has
   * requested exactly that, and stopping at forty of their eighteen hundred
   * files would mean forty-five presses, or eleven days of waiting for the
   * timer, to finish a thing they asked for once.
   */
  return refreshOne(ctx, userId, userId, EVERY_FILE, (at) => reportProgress(userId, at));
}

/** Higher than any student's Drive. Reads until there is nothing left. */
const EVERY_FILE = 100_000;

async function refreshOne(
  ctx: AppContext,
  agentId: string,
  userId: string,
  /** How many files to read. Left alone, the timer's modest per-pass default. */
  fileLimit?: number,
  /** Called as each phase begins and advances. Absent for the timer. */
  onPhase?: (at: { phase: BuildPhase; done: number; total: number }) => void,
): Promise<string> {
  const [owner] = await ctx.db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!owner) return 'no owner';

  const grant = await getGoogleGrant(ctx.db, userId);
  if (!grant.scope) return 'google not connected';

  const toolContext: ToolContext = {
    userId,
    agentId,
    google: new BetterAuthGoogleTokenProvider(ctx.auth, userId, grant.groups, grant.scope),
  };

  const vault = new Vault(ctx.env.VAULT_ROOT as string, userId);

  onPhase?.({ phase: 'classroom', done: 0, total: 0 });
  const { snapshot } = await collectClassroomSnapshot(toolContext);

  /*
   * Which of these courses belong in a vault at all.
   *
   * Nineteen courses on a real account, six of them last year's. Filtering
   * before the import rather than after it is what stops the expensive half
   * ever happening: no notes to write, nothing for search to rank, and none of
   * their Drive attachments read at a model call each.
   *
   * Every build re-decides, so correcting the rule corrects the vault.
   */
  const today = new Date().toISOString().slice(0, 10);

  /*
   * The school's own calendar, where anything has researched it.
   *
   * Read once. The dependency runs in a circle -- the school page is written
   * from a vault this filtered -- and resolves because the filter re-runs on
   * every build: the first uses a July fallback, the page gets researched, and
   * the next build uses the real date.
   */
  const yearEnd = await academicYearEnd(vault);

  /*
   * What the school says about itself, for the pass that decides what a course
   * is.
   *
   * Schools name their houses and their pastoral programmes after anything --
   * a colour, a founder, a language. A room called French on this account turned
   * out to be a house, and a researched page naming those structures is the only
   * thing that can tell one from a French class from the outside.
   */
  const school = (await readDocument(vault, SCHOOL_DOC_NAME))?.body;
  const yearStart = academicYearStart(today, yearEnd ?? FALLBACK_YEAR_END);

  const verdicts = await classifyCourses(
    { llm: await ctx.llm.resolve(userId) },
    {
      courses: describeCourses(snapshot, today),
      today,
      ...(yearEnd ? { yearEnd } : {}),
      ...(school ? { school } : {}),
      userId,
    },
  );
  const dropped = verdicts.filter((verdict) => !verdict.keep);
  const classroom = await importClassroom(vault, filterSnapshot(snapshot, verdicts));

  /*
   * Mail only for a vault that already has a school in it.
   *
   * An episode's whole value is the entity it links to, and on an empty vault
   * there is nothing to link to -- so the first pass would spend a model call
   * per message to produce notes joined to nothing.
   */
  let mail = { written: 0, people: 0 };
  if (domainOf(owner.email) && (await vault.has())) {
    // Asked each refresh rather than cached: a student changes schools, and a
    // domain list frozen at first sign-in would quietly stop matching.
    onPhase?.({ phase: 'mail', done: 0, total: 0 });
    const domains = await discoverSchoolDomains(toolContext, owner.email);
    const found = await collectSchoolMail(toolContext, { domains });
    if (!found.hitCeiling) {
      const entities = (await vault.list('entity')).map((note) => note.name);
      mail = await importMail(
        {
          llm: await ctx.llm.resolve(userId),
          ...(onPhase
            ? {
                onProgress: (done: number, total: number) =>
                  onPhase({ phase: 'mail', done, total }),
              }
            : {}),
        },
        {
          vault,
          messages: found.messages,
          entities,
          userId,
          domains,
          // Or a year of last year's mail writes back every course the
          // filter above just refused.
          dropped: dropped.map((verdict) => verdict.course),
          // And the courses it never saw, because Classroom no longer returns
          // them at all. Those get no verdict, so nothing else can refuse them.
          since: yearStart,
        },
      );
    }
  }

  /*
   * The student's own Drive: their essays, their revision, their project.
   *
   * Listing is free and needs no model, so it happens every refresh and picks
   * up whatever is new. What each file is actually about is settled by the
   * reading pass below, which has to open it anyway.
   */
  onPhase?.({ phase: 'drive', done: 0, total: 0 });
  const drive = await importDrive(vault, await collectDriveFiles(toolContext));

  /*
   * And read some of the files, a few at a time.
   *
   * A real account has hundreds of them and each one is a model call, so this
   * is deliberately a trickle on the refresh cadence rather than a bootstrap
   * that bills for everything at once. Everything it writes is durable, so
   * being interrupted costs one file.
   */
  const files = await readFileContents(
    {
      llm: await ctx.llm.resolve(userId),
      /*
       * null means the document has no text; a throw means we could not get
       * at it. Only the first is worth recording against the file, and
       * telling them apart is what stops an account without Drive access
       * marking every file it owns as empty. See vault/drive-text.ts.
       */
      read: async (fileId) =>
        textFromDriveRead(await readDriveFile.execute({ fileId } as never, toolContext)),
    },
    { vault, userId, ...(fileLimit === undefined ? {} : { limit: fileLimit }) },
  );

  /*
   * And out with anything a dropped course left behind.
   *
   * The filter above stops new notes being written; this is for the ones
   * already on disk -- the morning after a year ends, or the build after the
   * classifier is corrected. Teachers and the student's own words are spared.
   */
  const swept = await sweepDroppedCourses(vault, verdicts);

  /*
   * And the files that belong to no course they take.
   *
   * The Drive import will not bring one in any more, but a vault built before
   * that rule is full of them -- a thousand of twelve hundred on the first real
   * account, attached to nothing and answering searches about subjects that
   * ended in June.
   */
  const loose = await sweepUnattachedFiles(vault);

  /*
   * And the mail about classes they no longer take.
   *
   * The last place last year survives: the course is gone and its assignments
   * went with it, and the mail stayed because the course was removed thoroughly
   * enough that nothing was left to sweep it with.
   */
  const oldMail = await sweepCourseMail(vault, verdicts);

  /*
   * A page per class, from the notes now filed under each.
   *
   * Skipped where nothing under a subject has changed since the page was last
   * written, which is what stops a six-hourly build paying a model call per
   * class per pass to produce yesterday's prose.
   */
  onPhase?.({ phase: 'classes', done: 0, total: 0 });
  const classes = await writeClassDocs(
    { llm: await ctx.llm.resolve(userId) },
    { vault, userId, verdicts },
  );

  /*
   * A page per person, which is what survives a class being tidied away.
   *
   * Everything else about a finished course is filtered out before it reaches
   * the vault. The people are distilled instead: a teacher outlives the year
   * they taught, may teach this student again, and in five years this page may
   * be the only thing left saying who taught them Grade 8 science.
   */
  const self = (await vault.list('entity')).find(
    (note) =>
      note.description === 'Person' && note.externalId?.toLowerCase() === owner.email.toLowerCase(),
  )?.name;

  const people = await writePersonDocs(
    { llm: await ctx.llm.resolve(userId) },
    { vault, userId, ...(self ? { self } : {}) },
  );

  /*
   * And the page for what they have said, empty until they say it.
   *
   * Made here so a vault is never missing one: the picture of a vault should
   * show every page it will ever have, and this one otherwise appears only
   * after a student has confided something durable.
   */
  await ensureChatsDoc(vault);

  /*
   * Last, because it describes everything above it.
   *
   * Written from the pages rather than the notes, so it costs one model call
   * however large the vault is -- and rewritten whole every time, because those
   * pages are ground truth and a document that accumulates ends up describing a
   * student who left two years ago.
   *
   * The school page is not written here. It is the one pass that reaches the
   * open web, a school's calendar does not change between Tuesdays, and it is
   * asked for deliberately rather than every six hours.
   */
  const about = await writeUserDoc(
    { llm: await ctx.llm.resolve(userId) },
    {
      vault,
      userId,
      ...(owner.name ? { name: owner.name } : {}),
    },
  );

  return (
    `${classroom.written}+${classroom.updated} classroom, ${mail.written} episodes, ` +
    `${drive.written} drive files, ${files.read} read (${files.remaining} to go)` +
    `${dropped.length > 0 ? `, dropped ${dropped.length} courses (${swept.removed} notes)` : ''}` +
    `${loose.removed > 0 ? `, ${loose.removed} unattached files` : ''}` +
    `${oldMail.removed > 0 ? `, ${oldMail.removed} old-class messages` : ''}` +
    `, ${classes.written} class pages (${classes.skipped} unchanged, ${classes.removed} gone)` +
    `, ${people.written} people (${people.skipped} unchanged, ${people.removed} gone)` +
    `${about ? `, wrote user.md (${about.length} chars)` : ''}`
  );
}

/**
 * Start the periodic refresh, if this deployment has vaults at all.
 *
 * Returns a stop function, so a test or a shutdown can end it rather than
 * leaving a timer holding the process open.
 */
export function startVaultRefresh(ctx: AppContext): () => void {
  if (!ctx.env.VAULT_ROOT) return () => {};

  const pass = async (): Promise<void> => {
    try {
      /*
       * Every student, and their agents if they have any.
       *
       * A left join rather than a select from agents: a vault outlives the
       * agents that were reading it, and one with no agents still needs
       * keeping up to date. The batch bounds students, which is the thing a
       * pass actually costs.
       */
      const rows = await ctx.db
        .select({ userId: user.id, agentId: agents.id })
        .from(user)
        .leftJoin(agents, eq(agents.userId, user.id));

      for (const userId of studentsToRefresh(rows, BATCH)) {
        try {
          const agentId = rows.find((row) => row.userId === userId)?.agentId ?? userId;
          console.log(`Vault ${userId}: ${await refreshOne(ctx, agentId, userId)}`);
        } catch (error) {
          // One student's expired token must not stop the rest.
          console.error(`Vault refresh failed for ${userId}`, error);
        }
      }
    } catch (error) {
      console.error('Vault refresh pass failed', error);
    }
  };

  // Not on boot: a deploy restarts the process, and a refresh on every deploy
  // would import the same mail repeatedly while somebody is iterating.
  const timer = setInterval(() => void pass(), EVERY);
  return () => clearInterval(timer);
}
