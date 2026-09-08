import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { user } from '@contexto/db';
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
import type { ToolContext } from '@contexto/agent';
import type { AppContext } from './context.js';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from './google/connections.js';
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

/** Quiet before a bell rings. Docs autosaves every few seconds while a student types. */
const DEBOUNCE_MS = { gmail: 20_000, drive: 90_000 } as const;

/** Files summarised per live sync. The slow refresh reads the rest. */
const LIVE_FILE_CAP = 20;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Renew a watch this close to its end. Both expire within a week. */
const RENEW_WITHIN = 2 * DAY;

export class Bells {
  readonly #pending = new Map<
    string,
    { sources: Sources; timer: NodeJS.Timeout; deadline: number }
  >();
  #handler: (userId: string, sources: Sources) => void = () => {};

  constructor(private readonly delays: { gmail: number; drive: number } = DEBOUNCE_MS) {}

  onRing(handler: (userId: string, sources: Sources) => void): void {
    this.#handler = handler;
  }

  ring(userId: string, source: keyof Sources): void {
    const now = Date.now();
    const wanted = now + this.delays[source];
    const current = this.#pending.get(userId);
    const sources: Sources = current?.sources ?? { gmail: false, drive: false };
    sources[source] = true;

    // A fast source may bring the deadline forward; a slow one never pushes it back.
    const deadline = current ? Math.min(current.deadline, wanted) : wanted;
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => {
      this.#pending.delete(userId);
      this.#handler(userId, sources);
    }, deadline - now);
    this.#pending.set(userId, { sources, timer, deadline });
  }

  pending(userId: string): boolean {
    return this.#pending.has(userId);
  }
}

/** The bells the webhook routes ring. Wired to a handler by startVaultLive. */
export const liveBells = new Bells();

/**
 * Sync one student from what changed.
 *
 * Reads the delta from each source that rang, writes and links the new
 * items, and spends a model call only where a person's words need
 * summarising. Returns a one-line summary for the log.
 */
export async function liveSync(ctx: AppContext, userId: string, sources: Sources): Promise<string> {
  const [owner] = await ctx.db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!owner) return 'no owner';

  const grant = await getGoogleGrant(ctx.db, userId);
  const google = new BetterAuthGoogleTokenProvider(ctx.auth, userId, grant.groups, grant.scope);
  const readiness = await checkReadiness(grantedScopes(grant.scope), owner.email, () =>
    google.getAccessToken('classroom'),
  );
  if (!readiness.ready) return `not ready: ${unreadyReason(readiness)}`;

  const vault = new Vault(ctx.env.VAULT_ROOT as string, userId);
  // The first build makes the vault; a live sync has nothing to add to nothing.
  if (!(await vault.has())) return 'no vault yet';

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
      const fresh = await startPageToken(token);
      if (!isUnavailable(fresh)) await updateSyncState(ctx.db, userId, { drivePageToken: fresh });
      parts.push('drive token armed');
    } else if (token && state?.drivePageToken) {
      const changes = await collectDriveChanges(toolContext, state.drivePageToken);
      if (isUnavailable(changes)) {
        // A token Drive no longer honours. Start again; the slow refresh's
        // full listing reconciles whatever happened in between.
        const fresh = await startPageToken(token);
        if (!isUnavailable(fresh)) await updateSyncState(ctx.db, userId, { drivePageToken: fresh });
        parts.push('drive token reset');
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
  if (!readiness.ready) {
    await updateSyncState(ctx.db, userId, {
      gmailWatchExpiresAt: null,
      driveChannelExpiresAt: null,
    });
    return;
  }

  const state = await syncStateOf(ctx.db, userId);
  const soon = Date.now() + RENEW_WITHIN;
  const lapsing = (at: Date | null | undefined) => !at || at.getTime() < soon;

  if (ctx.env.GMAIL_PUBSUB_TOPIC && lapsing(state?.gmailWatchExpiresAt)) {
    const token = await google.getAccessToken('gmail');
    if (token) {
      const watch = await watchMailbox(token, ctx.env.GMAIL_PUBSUB_TOPIC);
      if (!isUnavailable(watch)) {
        await updateSyncState(ctx.db, userId, {
          gmailWatchExpiresAt: new Date(Number(watch.expiration)),
        });
      } else console.warn(`[live] ${userId} gmail watch refused: ${watch.reason}`);
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
      if (state?.driveChannelId && state.driveResourceId) {
        await stopChannel(token, { id: state.driveChannelId, resourceId: state.driveResourceId });
      }
      await updateSyncState(ctx.db, userId, {
        drivePageToken: pageToken,
        driveChannelId: channel.id,
        driveResourceId: watch.resourceId,
        driveChannelSecret: channel.token,
        driveChannelExpiresAt: new Date(Number(watch.expiration)),
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

  const everyone = async (): Promise<string[]> =>
    (await ctx.db.select({ id: user.id }).from(user)).map((row) => row.id);

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
