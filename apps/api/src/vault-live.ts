import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { account, user } from '@contexto/db';
import {
  FALLBACK_YEAR_END,
  SCHOOL_DOC_NAME,
  Vault,
  academicYearEnd,
  academicYearStart,
  classroomEpisode,
  collectClassroomSnapshot,
  collectDriveChanges,
  collectSchoolMail,
  domainOf,
  filterSnapshot,
  importClassroom,
  importDrive,
  importMail,
  isUnavailable,
  judgeDriveFiles,
  lastCourseVerdicts,
  readDocument,
  readDriveFile,
  readFileContents,
  readGrade,
  rememberDriveFilesOut,
  removeDriveFiles,
  schoolDomains,
  startPageToken,
  stopChannel,
  textFromDriveRead,
  watchChanges,
  watchMailbox,
} from '@contexto/agent';
import type { ToolContext, ToolUnavailable } from '@contexto/agent';
import type { AppContext } from './context.js';
import {
  BetterAuthGoogleTokenProvider,
  GOOGLE_PROVIDER_ID,
  getGoogleGrant,
} from './google/connections.js';
import { checkReadiness, grantedScopes, unreadyReason } from './vault-build.js';
import { studentQueue } from './vault-queue.js';
import { syncStateOf, updateSyncState } from './vault-sync-state.js';

/**
 * The live tier: a teacher posts, a school email lands, a student saves a
 * document, and within about a minute it is in the vault.
 *
 * One engine, liveSync, fetches only what changed. Two things ring it: a
 * push from Google, arriving at routes/hooks.ts, or the poll timer below
 * where push is not set up. Both go through the same Bells, which wait for
 * quiet and ring once, and every sync runs on the student's own queue.
 */

export interface Sources {
  gmail: boolean;
  drive: boolean;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Quiet a source must fall into before its bell rings. */
const DEBOUNCE_MS = { gmail: 20_000, drive: 90_000 } as const;

/** However long a source keeps ringing, it waits no longer than this from its first ring. */
const MAX_WAIT = 5 * MINUTE;

/** Files summarised per live sync. The slow refresh reads the rest. */
const LIVE_FILE_CAP = 20;

/** Renew a watch this close to its end. Both expire within a week. */
const RENEW_WITHIN = 2 * DAY;

interface Pending {
  sources: Sources;
  /** Per source that rang: the moment it is willing to be woken at. */
  deadline: Partial<Record<keyof Sources, number>>;
  /** Per source that rang: its first ring of this window, for the cap. */
  firstRing: Partial<Record<keyof Sources, number>>;
  timer: NodeJS.Timeout;
}

/**
 * A quiet window per source, capped.
 *
 * Google rings once per mailbox change and once per autosave in Docs, so a
 * student typing in a document rings every few seconds. Each source waits for
 * its OWN quiet -- 20 seconds for Gmail, 90 for Drive -- and every further
 * ring pushes that source's deadline out again, but never past five minutes
 * from its first ring, so a long editing session still syncs while it happens.
 *
 * The timer fires at the earliest deadline among the pending sources and
 * delivers all of them in one ring. So a Gmail bell during a pending Drive
 * window rings at Gmail's twenty seconds and carries the Drive work with it.
 */
export class Bells {
  readonly #pending = new Map<string, Pending>();
  #handler: (userId: string, sources: Sources) => void = () => {};

  constructor(private readonly delays: { gmail: number; drive: number } = DEBOUNCE_MS) {}

  onRing(handler: (userId: string, sources: Sources) => void): void {
    this.#handler = handler;
  }

  ring(userId: string, source: keyof Sources): void {
    const now = Date.now();
    const current = this.#pending.get(userId);
    const sources: Sources = current?.sources ?? { gmail: false, drive: false };
    sources[source] = true;

    const firstRing = { ...current?.firstRing };
    const first = firstRing[source] ?? now;
    firstRing[source] = first;

    const deadline = { ...current?.deadline };
    deadline[source] = Math.min(now + this.delays[source], first + MAX_WAIT);
    const earliest = Math.min(
      ...Object.values(deadline).filter((at): at is number => at !== undefined),
    );

    if (current) clearTimeout(current.timer);
    const timer = setTimeout(
      () => {
        this.#pending.delete(userId);
        this.#handler(userId, sources);
      },
      Math.max(0, earliest - now),
    );
    this.#pending.set(userId, { sources, deadline, firstRing, timer });
  }

  pending(userId: string): boolean {
    return this.#pending.has(userId);
  }
}

/**
 * Whether Drive refused the stored change token, rather than merely failing.
 *
 * This matters because the change feed is the only path that takes a deleted
 * file out of the vault. Resetting the token on a passing 500 skips over
 * every deletion that happened while it was still valid, and nothing later
 * notices they are missing. Drive refuses a token it no longer honours with
 * 404, 410, or a 400 that names the page token; everything else keeps the
 * token and is retried on the next bell.
 */
export function driveTokenRejected(result: ToolUnavailable): boolean {
  if (result.status === 404 || result.status === 410) return true;
  return result.status === 400 && /page ?token/i.test(result.message ?? '');
}

/** The bells the webhook routes ring. Wired to a handler by startVaultLive. */
export const liveBells = new Bells();

/**
 * Take a change token from Drive and store it, and say which happened.
 *
 * The summary line is the only record of where a student's Drive sync starts
 * from, so it reports the write rather than the intention: "drive token reset"
 * beside a row that still holds the old token would be the log lying about
 * the one thing this does.
 */
async function freshDriveToken(
  ctx: AppContext,
  userId: string,
  token: string,
  what: 'armed' | 'reset',
): Promise<string> {
  const fresh = await startPageToken(token);
  if (isUnavailable(fresh)) return `drive token unavailable: ${fresh.reason}`;
  await updateSyncState(ctx.db, userId, { drivePageToken: fresh });
  return `drive token ${what}`;
}

/**
 * Sync one student from what changed.
 *
 * Reads the delta from each source that rang, writes and links the new
 * items, and spends a model call only where a person's words need
 * summarising. Returns a one-line summary for the log.
 */
export async function liveSync(ctx: AppContext, userId: string, sources: Sources): Promise<string> {
  if (!ctx.env.VAULT_ROOT) return 'no vault root';

  const [owner] = await ctx.db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!owner) return 'no owner';

  /*
   * The cheapest question first. The poll rings every student on an interval,
   * and readiness costs a token refresh against Google -- paid on every tick
   * for every student who has never built a vault, to learn nothing.
   *
   * The first build makes the vault; a live sync has nothing to add to nothing.
   */
  const vault = new Vault(ctx.env.VAULT_ROOT, userId);
  if (!(await vault.has())) return 'no vault yet';

  const grant = await getGoogleGrant(ctx.db, userId);
  const google = new BetterAuthGoogleTokenProvider(ctx.auth, userId, grant.groups, grant.scope);
  const readiness = await checkReadiness(grantedScopes(grant.scope), owner.email, () =>
    google.getAccessToken('classroom'),
  );
  if (!readiness.ready) return `not ready: ${unreadyReason(readiness)}`;

  const toolContext: ToolContext = { userId, agentId: userId, google };
  const state = await syncStateOf(ctx.db, userId);
  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = await academicYearEnd(vault);
  const yearStart = academicYearStart(today, yearEnd ?? FALLBACK_YEAR_END);
  const school = (await readDocument(vault, SCHOOL_DOC_NAME))?.body;
  const verdicts = await lastCourseVerdicts(vault);
  const dropped = verdicts.filter((verdict) => !verdict.keep).map((verdict) => verdict.course);
  const parts: string[] = [];
  let classroomPosted = false;

  if (sources.gmail && domainOf(owner.email)) {
    const domains = state?.schoolDomains ?? schoolDomains(owner.email, []);
    const known = new Set(
      (await vault.list('episode')).map((note) => note.externalId).filter(Boolean) as string[],
    );
    const found = await collectSchoolMail(toolContext, { domains, newerThan: '2d', skip: known });
    // Said out loud, because both are silent ways for mail to go missing from
    // a sync that otherwise reports a cheerful "nothing new".
    if (found.hitCeiling) parts.push('mail listing hit ceiling');
    if (found.skipped.length > 0) {
      parts.push(`${found.skipped.length} mail problems`);
      console.warn(`[live] ${userId} mail: ${found.skipped.slice(0, 3).join('; ')}`);
    }
    if (found.messages.length > 0) {
      const entities = (await vault.list('entity')).map((note) => note.name);
      const mail = await importMail(
        { llm: await ctx.llm.resolve(userId) },
        { vault, messages: found.messages, entities, userId, domains, dropped, since: yearStart },
      );
      parts.push(`${mail.written} episodes`);
      classroomPosted = found.messages.some((message) => classroomEpisode(message)?.keep === true);
    }
  }

  /*
   * A Classroom notification means Classroom has something new. The tools
   * cannot fetch one course, so the whole snapshot is pulled -- sixty
   * requests, twenty seconds, no model -- and imported under the verdicts
   * the slow refresh last gave. No verdicts yet means no slow refresh yet,
   * and that pass will import everything itself.
   */
  if (classroomPosted && verdicts.length > 0) {
    const { snapshot } = await collectClassroomSnapshot(toolContext);
    const classroom = await importClassroom(vault, filterSnapshot(snapshot, verdicts));
    parts.push(`${classroom.written}+${classroom.updated} classroom`);
  }

  if (sources.drive) {
    const token = await google.getAccessToken('drive');
    if (token && !state?.drivePageToken) {
      // Nothing to diff against yet. From here on, changes are changes.
      parts.push(await freshDriveToken(ctx, userId, token, 'armed'));
    } else if (token && state?.drivePageToken) {
      const changes = await collectDriveChanges(toolContext, state.drivePageToken);
      if (isUnavailable(changes) && !driveTokenRejected(changes)) {
        // Drive wobbled, and the token is still good. Keeping it means the
        // next bell asks the same question and gets the deletions too.
        parts.push(`drive unavailable: ${changes.reason}`);
      } else if (isUnavailable(changes)) {
        // A token Drive no longer honours. Start again; the slow refresh's
        // full listing reconciles whatever happened in between.
        parts.push(await freshDriveToken(ctx, userId, token, 'reset'));
      } else {
        const removed = await removeDriveFiles(vault, changes.removed);
        let written = 0;
        let read = 0;
        if (changes.changed.length > 0) {
          const grade = await readGrade(vault, { today, ...(yearEnd ? { yearEnd } : {}) });
          const llm = await ctx.llm.resolve(userId);
          const judged = await judgeDriveFiles(
            { llm },
            {
              vault,
              files: changes.changed,
              today,
              yearStart,
              ...(school ? { school } : {}),
              dropped,
              ...(grade ? { grade: grade.grade } : {}),
              userId,
            },
          );
          const drive = await importDrive(vault, changes.changed, judged);
          written = drive.written;
          const files = await readFileContents(
            {
              llm,
              read: async (fileId) =>
                textFromDriveRead(await readDriveFile.execute({ fileId } as never, toolContext)),
            },
            {
              vault,
              userId,
              limit: LIVE_FILE_CAP,
              only: new Set(changes.changed.map((file) => file.fileId)),
            },
          );
          read = files.read;
          await rememberDriveFilesOut(vault, changes.changed, files.blank);
        }
        await updateSyncState(ctx.db, userId, { drivePageToken: changes.pageToken });
        parts.push(`${written} drive files, ${read} read, ${removed} removed`);
      }
    }
  }

  await updateSyncState(ctx.db, userId, { lastLiveSyncAt: new Date() });
  return parts.join(', ') || 'nothing new';
}

/** Google's expiry, in epoch milliseconds as a string. Null when it is not one. */
function expiryOf(expiration: string): Date | null {
  const ms = Number(expiration);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Arm or renew this student's Google watches.
 *
 * Gmail publishes to the Pub/Sub topic when one is configured. Drive posts
 * to our hook when this API is reachable over https. Both lapse within a
 * week, so anything ending within two days is renewed, and a replaced Drive
 * channel is stopped so it does not ring twice.
 */
export async function armWatches(ctx: AppContext, userId: string): Promise<void> {
  const [owner] = await ctx.db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!owner) return;
  const grant = await getGoogleGrant(ctx.db, userId);
  const google = new BetterAuthGoogleTokenProvider(ctx.auth, userId, grant.groups, grant.scope);
  const readiness = await checkReadiness(grantedScopes(grant.scope), owner.email, () =>
    google.getAccessToken('classroom'),
  );
  const state = await syncStateOf(ctx.db, userId);

  if (!readiness.ready) {
    /*
     * Clear the channel, not just its expiry. A live Drive channel goes on
     * posting for its whole week, and a row that has forgotten the id and the
     * secret cannot match those posts to a student -- so every one of them is
     * answered with a 404 the hook logs, for a student nothing can sync.
     */
    if (state?.driveChannelId && state.driveResourceId) {
      const token = await google.getAccessToken('drive');
      // No token, no way to ask Drive to stop. It lapses within the week.
      if (token) {
        await stopChannel(token, { id: state.driveChannelId, resourceId: state.driveResourceId });
      }
    }
    await updateSyncState(ctx.db, userId, {
      gmailWatchExpiresAt: null,
      driveChannelExpiresAt: null,
      driveChannelId: null,
      driveResourceId: null,
      driveChannelSecret: null,
    });
    return;
  }

  const soon = Date.now() + RENEW_WITHIN;
  const lapsing = (at: Date | null | undefined) => !at || at.getTime() < soon;

  if (ctx.env.GMAIL_PUBSUB_TOPIC && lapsing(state?.gmailWatchExpiresAt)) {
    const token = await google.getAccessToken('gmail');
    if (token) {
      const watch = await watchMailbox(token, ctx.env.GMAIL_PUBSUB_TOPIC);
      if (isUnavailable(watch))
        console.warn(`[live] ${userId} gmail watch refused: ${watch.reason}`);
      else {
        const expires = expiryOf(watch.expiration);
        // An unreadable expiry stored as an Invalid Date makes every later
        // renewal check say "not lapsing" and the watch dies unnoticed.
        if (expires === null) {
          console.warn(`[live] ${userId} gmail watch expiry unreadable: ${watch.expiration}`);
        } else {
          await updateSyncState(ctx.db, userId, { gmailWatchExpiresAt: expires });
        }
      }
    }
  }

  if (ctx.env.API_BASE_URL.startsWith('https://') && lapsing(state?.driveChannelExpiresAt)) {
    const token = await google.getAccessToken('drive');
    if (token) {
      const pageToken = state?.drivePageToken ?? (await startPageToken(token));
      if (isUnavailable(pageToken)) return;
      const channel = {
        id: randomUUID(),
        address: `${ctx.env.API_BASE_URL}/api/hooks/drive`,
        token: randomBytes(24).toString('hex'),
        expiresAt: Date.now() + 7 * DAY - MINUTE,
      };
      const watch = await watchChanges(token, pageToken, channel);
      if (isUnavailable(watch)) {
        console.warn(`[live] ${userId} drive watch refused: ${watch.reason}`);
        return;
      }
      const expires = expiryOf(watch.expiration);
      if (expires === null) {
        console.warn(`[live] ${userId} drive watch expiry unreadable: ${watch.expiration}`);
        return;
      }
      if (state?.driveChannelId && state.driveResourceId) {
        await stopChannel(token, { id: state.driveChannelId, resourceId: state.driveResourceId });
      }
      await updateSyncState(ctx.db, userId, {
        drivePageToken: pageToken,
        driveChannelId: channel.id,
        driveResourceId: watch.resourceId,
        driveChannelSecret: channel.token,
        driveChannelExpiresAt: expires,
      });
    }
  }
}

/**
 * Start the live tier: wire the bells, the poll trigger and the daily renewal.
 *
 * Returns a stop function so a test or a shutdown can end it.
 */
export function startVaultLive(ctx: AppContext): () => void {
  if (!ctx.env.VAULT_ROOT) return () => {};

  liveBells.onRing((userId, sources) => {
    void studentQueue
      .run(userId, () => liveSync(ctx, userId, sources))
      .then(
        (summary) => console.log(`Live ${userId}: ${summary}`),
        (error: unknown) => console.error(`Live sync failed for ${userId}`, error),
      );
  });

  /*
   * Students who have connected Google, not every account on the box. The
   * live tier has nothing to fetch for anyone else, and ringing them costs a
   * poll's worth of queries and readiness checks every five minutes to find
   * that out again.
   */
  const everyone = async (): Promise<string[]> =>
    (
      await ctx.db
        .selectDistinct({ id: account.userId })
        .from(account)
        .where(eq(account.providerId, GOOGLE_PROVIDER_ID))
    ).map((row) => row.id);

  const timers: NodeJS.Timeout[] = [];

  const pollMinutes = ctx.env.VAULT_LIVE_POLL_MINUTES;
  if (pollMinutes > 0) {
    const poll = async () => {
      try {
        for (const userId of await everyone()) {
          liveBells.ring(userId, 'gmail');
          liveBells.ring(userId, 'drive');
        }
      } catch (error) {
        console.error('Live poll failed', error);
      }
    };
    timers.push(setInterval(() => void poll(), pollMinutes * MINUTE));
  }

  const renewAll = async () => {
    try {
      for (const userId of await everyone()) {
        try {
          await armWatches(ctx, userId);
        } catch (error) {
          console.error(`Arming watches failed for ${userId}`, error);
        }
      }
    } catch (error) {
      console.error('Watch renewal failed', error);
    }
  };
  // Soon after boot, then daily. Renewal is idempotent, so a deploy costs nothing.
  timers.push(setTimeout(() => void renewAll(), MINUTE));
  timers.push(setInterval(() => void renewAll(), DAY));

  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}
