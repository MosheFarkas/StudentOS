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
  judgeDriveFiles,
  rememberDriveFilesOut,
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
  describeOrphanCourses,
  filterSnapshot,
  writeClassDocs,
  writePersonDocs,
  ensureChatsDoc,
  sweepDroppedCourses,
  sweepCourseMail,
  sweepUnattachedFiles,
  readDriveFile,
  textFromDriveRead,
  readGrade,
  courseFingerprint,
  recallCourseVerdicts,
  rememberCourseVerdicts,
} from '@contexto/agent';
import type { ToolContext } from '@contexto/agent';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from './google/connections.js';
import type { AppContext } from './context.js';
import {
  checkReadiness,
  grantedScopes,
  reportProgress,
  unreadyReason,
  type BuildPhase,
} from './vault-build.js';
import { updateSyncState, allSyncStates } from './vault-sync-state.js';
import { studentQueue } from './vault-queue.js';

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

/** Wait this long after boot before the first pass, so a deploy settles first. */
const AFTER_BOOT = 3 * 60 * 1000;

/**
 * The students to refresh this pass, stalest first.
 *
 * The vault used to belong to an agent, so this loop was over agents, and a
 * student with none was never refreshed. Then it took the first five rows in
 * table order, and a sixth student was never refreshed either. Now every
 * student is listed, those never refreshed come first, and the pass runs
 * down the list until its time budget ends -- so nobody waits for ever, and
 * one wake still cannot run for an hour.
 *
 * A student whose refresh fails still records the attempt, so they rotate to
 * the back of this order rather than sorting first, and failing, forever.
 */
export function studentsToRefresh(
  rows: readonly { userId: string; agentId: string | null }[],
  lastRefreshed: ReadonlyMap<string, Date | null>,
  options: { overdueBefore?: Date } = {},
): string[] {
  const students = [...new Set(rows.map((row) => row.userId))];
  const when = (userId: string) => lastRefreshed.get(userId)?.getTime() ?? 0;
  const due = options.overdueBefore
    ? students.filter((userId) => when(userId) < (options.overdueBefore as Date).getTime())
    : students;
  return due.sort((a, b) => when(a) - when(b));
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

  /*
   * lastRefreshAt records the last attempt, not the last success, from here
   * on -- a student whose refresh reliably fails must still rotate to the
   * back of the stalest-first queue, or everyone behind them waits forever.
   */
  try {
    const grant = await getGoogleGrant(ctx.db, userId);
    const google = new BetterAuthGoogleTokenProvider(ctx.auth, userId, grant.groups, grant.scope);

    /*
     * Everything consented and still honoured, or nothing is built.
     *
     * Here because this is the one path every build takes -- the button, the
     * timer and the script. A build that went ahead on a dead token wrote an
     * empty vault and a summary that read like a student with no school.
     */
    const readiness = await checkReadiness(grantedScopes(grant.scope), owner.email, () =>
      google.getAccessToken('classroom'),
    );
    if (!readiness.ready) {
      const why = unreadyReason(readiness);
      console.warn(`[vault] ${userId} not built: ${why}`);
      return `not ready: ${why}`;
    }

    const toolContext: ToolContext = { userId, agentId, google };

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

    /*
     * The roster, and what the vault holds that is no longer on it.
     *
     * A course the school deletes, or takes the student out of, stops coming
     * back from Classroom -- and a course the classifier never sees is one the
     * sweep below can never drop. Last year's exam prep sat in a real vault on
     * exactly those terms, so those are judged too, from their own notes.
     */
    const described = [
      ...describeCourses(snapshot, today),
      ...(await describeOrphanCourses(vault, snapshot, today)),
    ];
    const fingerprint = courseFingerprint(described, yearStart, yearEnd ?? undefined, school);
    /*
     * Asked only when the question changed.
     *
     * The described courses, the year boundary and the school page are the
     * whole prompt. Same prompt, same rule: the last answer stands, and a
     * quiet pass costs no call here. Held verdicts are never remembered, so a
     * silence is asked again.
     */
    const verdicts =
      (await recallCourseVerdicts(vault, fingerprint)) ??
      (await classifyCourses(
        { llm: await ctx.llm.resolve(userId) },
        {
          courses: described,
          today,
          ...(yearEnd ? { yearEnd } : {}),
          ...(school ? { school } : {}),
          userId,
        },
      ));
    await rememberCourseVerdicts(vault, fingerprint, verdicts);
    const dropped = verdicts.filter((verdict) => !verdict.keep);

    /*
     * A course the classifier never answered for is worth saying out loud.
     *
     * Silence used to be indistinguishable from a verdict, and the build that
     * reinstated last year's science as a current subject looked exactly like
     * every other build in this log.
     */
    const held = verdicts.filter((verdict) => verdict.subject === null);
    if (held.length > 0) {
      console.warn(
        `[vault] ${held.length} of ${verdicts.length} courses went unanswered by the ` +
          `classifier and are held unjudged: ${held.map((v) => v.course).join(', ')}`,
      );
    }

    const classroom = await importClassroom(vault, filterSnapshot(snapshot, verdicts));

    /*
     * Mail only for a vault that already has a school in it.
     *
     * An episode's whole value is the entity it links to, and on an empty vault
     * there is nothing to link to -- so the first pass would spend a model call
     * per message to produce notes joined to nothing.
     */
    let mail = { written: 0, people: 0 };
    let mailKnown = 0;
    if (domainOf(owner.email) && (await vault.has())) {
      // Asked each refresh rather than cached: a student changes schools, and a
      // domain list frozen at first sign-in would quietly stop matching.
      onPhase?.({ phase: 'mail', done: 0, total: 0 });
      const domains = await discoverSchoolDomains(toolContext, owner.email);
      try {
        // Cached for the live sync's benefit, not this pass's. A database
        // hiccup here costs the live path one rediscovery; throwing would
        // cost this student their whole mail import.
        await updateSyncState(ctx.db, userId, { schoolDomains: domains });
      } catch (error) {
        console.warn(`[refresh] ${userId} could not cache school domains`, error);
      }
      const known = new Set(
        (await vault.list('episode')).map((note) => note.externalId).filter(Boolean) as string[],
      );
      const found = await collectSchoolMail(toolContext, { domains, skip: known });
      mailKnown = found.known;
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
     * up whatever is new. A folder that names a course places a file for
     * nothing; everything else is judged on its listing, fifty at a time,
     * against the courses and the school page -- and the verdict is kept, so a
     * file is asked about once. What each kept file is actually about is
     * settled by the reading pass below, which has to open it anyway.
     */
    onPhase?.({ phase: 'drive', done: 0, total: 0 });
    const listed = await collectDriveFiles(toolContext);
    // Which grade they are in now, so "Grade 10" in a file's name reads as last year's.
    const grade = await readGrade(vault, { today, ...(yearEnd ? { yearEnd } : {}) });
    const judged = await judgeDriveFiles(
      { llm: await ctx.llm.resolve(userId) },
      {
        vault,
        files: listed,
        today,
        yearStart,
        ...(school ? { school } : {}),
        // The subjects that are over, so their files are refused however good they are.
        dropped: dropped.map((verdict) => verdict.course),
        ...(grade ? { grade: grade.grade } : {}),
        userId,
      },
    );
    const drive = await importDrive(vault, listed, judged);

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
    // A document the reader opened and found blank stays out on later refreshes too.
    await rememberDriveFilesOut(vault, listed, files.blank);

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
        note.description === 'Person' &&
        note.externalId?.toLowerCase() === owner.email.toLowerCase(),
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
      `${drive.removed > 0 ? `, ${drive.removed} Drive files taken out` : ''}` +
      `${files.blank.length > 0 ? `, ${files.blank.length} blank` : ''}` +
      `${dropped.length > 0 ? `, dropped ${dropped.length} courses (${swept.removed} notes)` : ''}` +
      `${loose.removed > 0 ? `, ${loose.removed} unattached files` : ''}` +
      `${oldMail.removed > 0 ? `, ${oldMail.removed} old-class messages` : ''}` +
      `, ${classes.written} class pages (${classes.skipped} unchanged, ${classes.removed} gone)` +
      `, ${people.written} people (${people.skipped} unchanged, ${people.removed} gone)` +
      `${about ? `, wrote user.md (${about.length} chars)` : ''}` +
      `, ${mailKnown} mail already held`
    );
  } finally {
    try {
      await updateSyncState(ctx.db, userId, { lastRefreshAt: new Date() });
    } catch (error) {
      console.error(`[vault] ${userId} could not record the refresh attempt`, error);
    }
  }
}

/**
 * Start the periodic refresh, if this deployment has vaults at all.
 *
 * Returns a stop function, so a test or a shutdown can end it rather than
 * leaving a timer holding the process open.
 */
export function startVaultRefresh(ctx: AppContext): () => void {
  if (!ctx.env.VAULT_ROOT) return () => {};

  const pass = async (options: { onlyOverdue: boolean }): Promise<void> => {
    try {
      const rows = await ctx.db
        .select({ userId: user.id, agentId: agents.id })
        .from(user)
        .leftJoin(agents, eq(agents.userId, user.id));
      const lastRefreshed = new Map(
        (await allSyncStates(ctx.db)).map((state) => [state.userId, state.lastRefreshAt]),
      );
      const students = studentsToRefresh(
        rows,
        lastRefreshed,
        options.onlyOverdue ? { overdueBefore: new Date(Date.now() - EVERY) } : {},
      );

      // Bounded by time, not by a count: one wake still cannot run for an hour.
      const deadline = Date.now() + ctx.env.VAULT_REFRESH_BUDGET_MINUTES * 60 * 1000;
      for (const userId of students) {
        if (Date.now() > deadline) {
          console.log(
            `[vault] refresh budget spent; ${students.indexOf(userId)} of ${students.length} done`,
          );
          break;
        }
        try {
          const agentId = rows.find((row) => row.userId === userId)?.agentId ?? userId;
          const summary = await studentQueue.run(userId, () => refreshOne(ctx, agentId, userId));
          console.log(`Vault ${userId}: ${summary}`);
        } catch (error) {
          // One student's expired token must not stop the rest.
          console.error(`Vault refresh failed for ${userId}`, error);
        }
      }
    } catch (error) {
      console.error('Vault refresh pass failed', error);
    }
  };

  /*
   * Soon after boot, for the overdue only. A deploy restarts the process,
   * and the old rule of "never on boot" meant a deploy every few hours
   * stopped the refresh from ever running. Only the overdue, so a deploy
   * does not re-import for students refreshed an hour ago.
   */
  const first = setTimeout(() => void pass({ onlyOverdue: true }), AFTER_BOOT);
  const timer = setInterval(() => void pass({ onlyOverdue: false }), EVERY);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
