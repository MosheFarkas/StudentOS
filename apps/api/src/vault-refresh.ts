import { eq } from 'drizzle-orm';
import { agents, user } from '@contexto/db';
import {
  Vault,
  collectClassroomSnapshot,
  collectSchoolMail,
  discoverSchoolDomains,
  readFileContents,
  collectDriveFiles,
  importDrive,
  domainOf,
  importClassroom,
  importMail,
  isUnavailable,
  readDriveFile,
} from '@contexto/agent';
import type { ToolContext } from '@contexto/agent';
import { BetterAuthGoogleTokenProvider, getGoogleGrant } from './google/connections.js';
import type { AppContext } from './context.js';

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

async function refreshOne(ctx: AppContext, agentId: string, userId: string): Promise<string> {
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
  const { snapshot } = await collectClassroomSnapshot(toolContext);
  const classroom = await importClassroom(vault, snapshot);

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
    const domains = await discoverSchoolDomains(toolContext, owner.email);
    const found = await collectSchoolMail(toolContext, { domains });
    if (!found.hitCeiling) {
      const entities = (await vault.list('entity')).map((note) => note.name);
      mail = await importMail(
        { llm: await ctx.llm.resolve(userId) },
        { vault, messages: found.messages, entities, userId, domains },
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
      read: async (fileId) => {
        const out = await readDriveFile.execute({ fileId } as never, toolContext);
        if (isUnavailable(out)) return null;
        return (out as { content?: string }).content ?? null;
      },
    },
    { vault, userId },
  );

  return (
    `${classroom.written}+${classroom.updated} classroom, ${mail.written} episodes, ` +
    `${drive.written} drive files, ${files.read} read (${files.remaining} to go)`
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
      // Only agents whose student has connected Google. Everyone else has
      // nothing to import and would cost a query each to discover that.
      const owned = await ctx.db
        .select({ agentId: agents.id, userId: agents.userId })
        .from(agents)
        .limit(BATCH);

      for (const { agentId, userId } of owned) {
        try {
          console.log(`Vault ${agentId}: ${await refreshOne(ctx, agentId, userId)}`);
        } catch (error) {
          // One student's expired token must not stop the rest.
          console.error(`Vault refresh failed for ${agentId}`, error);
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
