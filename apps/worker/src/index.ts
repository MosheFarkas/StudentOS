/**
 * Background jobs.
 *
 * Runs as a separate process from the API because these are long, periodic, and
 * must not compete with request latency. On the droplet this is a second
 * systemd unit pointed at the same database.
 *
 * Currently registers one job and does nothing useful -- the summariser it
 * calls is a skeleton. It exists now so that when memory summarisation becomes
 * real there is somewhere obvious to put it.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@contexto/db';
import { CredentialVault, EnvMasterKeyProvider, LlmRegistry, QuotaService } from '@contexto/llm';
import {
  PostgresMemoryStore,
  PostgresProfileStore,
  Vault,
  importConversation,
  collectExchanges,
  updateChatsDoc,
  writeUserDoc,
} from '@contexto/agent';

/**
 * Everything the jobs share, built once.
 *
 * Deliberately not imported from apps/api: the worker is a separate process
 * with a separate lifetime, and reaching into another app's context would tie
 * a background job's startup to an HTTP server's.
 */
function loadDotEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function buildContext() {
  loadDotEnv();

  const url = process.env.DATABASE_URL;
  const masterKeyValue = process.env.MASTER_ENCRYPTION_KEY;
  if (!url || !masterKeyValue) {
    throw new Error('Worker needs DATABASE_URL and MASTER_ENCRYPTION_KEY');
  }

  const db = createDatabase({ url });
  const vault = new CredentialVault(db, new EnvMasterKeyProvider(masterKeyValue));
  const quotaCap = process.env.PLATFORM_MONTHLY_TOKEN_QUOTA;
  const quota = new QuotaService(db, quotaCap ? Number(quotaCap) : undefined);

  return {
    db,
    // Absent when the deployment has no vaults, in which case conversations
    // simply are not recorded there and nothing else changes.
    vaultRoot: process.env.VAULT_ROOT,
    memory: new PostgresMemoryStore(db),
    profiles: new PostgresProfileStore(db),
    llm: new LlmRegistry({
      vault,
      quota,
      ...(process.env.PLATFORM_OPENAI_API_KEY
        ? { platformApiKey: process.env.PLATFORM_OPENAI_API_KEY }
        : {}),
    }),
  };
}

let shared: ReturnType<typeof buildContext> | undefined;
function context(): ReturnType<typeof buildContext> {
  shared ??= buildContext();
  return shared;
}

const MINUTE = 60_000;

/**
 * Agents per pass.
 *
 * A query returning every agent works right up until it very suddenly does
 * not, and a pass that runs long holds a model call open per agent.
 */
const BATCH_SIZE = 50;

/**
 * How long an agent must have been silent before its profile is rewritten.
 *
 * The profile sits in the cached part of the system prompt, so a rewrite
 * between one turn and the next costs that conversation its cache for every
 * remaining turn. Fifteen minutes is comfortably longer than a pause for
 * thought and comfortably shorter than the hourly cadence, so an ordinary
 * conversation is written up on the next wake rather than the one after.
 */
const QUIET_FOR = 15 * MINUTE;

interface Job {
  name: string;
  intervalMs: number;
  run(): Promise<void>;
}

const jobs: Job[] = [
  {
    name: 'chats-page',
    // Hourly is a guess. The right cadence depends on how fast episodic memory
    // actually accumulates, which you will not know until real students use it.
    intervalMs: 60 * MINUTE,
    async run() {
      const ctx = context();
      const stale = await ctx.profiles.stale(BATCH_SIZE, QUIET_FOR);
      if (stale.length === 0) return;

      /*
       * Grouped by student, because the page is theirs.
       *
       * Staleness is tracked per agent -- that is where the watermark lives --
       * but there is one page per student. Two of their agents going quiet in
       * the same pass would otherwise race to rewrite the same file, and one of
       * the two rewrites would be thrown away.
       */
      const byStudent = new Map<string, string[]>();
      for (const { agentId, userId } of stale) {
        byStudent.set(userId, [...(byStudent.get(userId) ?? []), agentId]);
      }

      let changed = 0;
      let recorded = 0;
      for (const [userId, agentIds] of byStudent) {
        try {
          /*
           * Billed to the agent's owner, not to a shared key.
           *
           * The registry resolves per user, so a student on their own API key
           * pays for their own summarisation and a platform-tier student is
           * metered against their own quota. On a shared key this cost is
           * invisible until it is the largest line on the bill.
           */
          const llm = await ctx.llm.resolve(userId);

          const bursts = [];
          for (const agentId of agentIds) {
            bursts.push(
              await collectExchanges(
                { memory: ctx.memory, profiles: ctx.profiles },
                { agentId, userId },
              ),
            );
          }

          const exchanges = bursts.flatMap((burst) => burst.exchanges);
          if (exchanges.length === 0) continue;

          if (ctx.vaultRoot) {
            const vault = new Vault(ctx.vaultRoot, userId);
            const knownBefore = bursts
              .map((burst) => burst.knownBefore)
              .filter((known): known is string => known !== undefined);

            const written = await updateChatsDoc(
              { llm },
              { vault, exchanges, userId, ...(knownBefore.length > 0 ? { knownBefore } : {}) },
            );

            if (written.changed) {
              changed += 1;
              /*
               * And the page that describes them, because it is written from
               * this one.
               *
               * Otherwise something a student said this morning waits for the
               * six-hourly vault build to reach the page the agent actually
               * carries. Only when the chats page moved, which is the unusual
               * case -- most conversations teach nothing durable.
               *
               * Safe here and nowhere else: this job runs only once a student
               * has been quiet, so the page it rewrites is not the one being
               * read mid-conversation. Rewriting it during one would change the
               * system prompt under a live turn and cost the whole cached
               * prefix for the rest of that conversation.
               */
              await writeUserDoc({ llm }, { vault, userId });
            }
          }

          /*
           * The same burst, written into the vault as an episode.
           *
           * A conversation is not a row anywhere -- it is the exchanges
           * between one quiet period and the next, which the profile pass has
           * already worked out. Recording it here puts the student's own words
           * on the same timeline as their school, which is the only reason the
           * vault holds more than one source.
           *
           * Only for a vault that already exists: an agent whose student has
           * imported nothing gets a profile and no episodes, rather than a
           * vault containing conversations and no school.
           */
          if (ctx.vaultRoot) {
            const vault = new Vault(ctx.vaultRoot, userId);
            if (await vault.has()) {
              for (const burst of bursts) {
                if (burst.exchanges.length === 0 || !burst.newestId) continue;
                const written = await importConversation(
                  { llm },
                  {
                    vault,
                    exchanges: burst.exchanges,
                    conversationId: burst.newestId,
                    occurred: burst.occurred ?? new Date().toISOString(),
                    userId,
                  },
                );
                recorded += written.written;
              }
            }
          }
        } catch (error) {
          // One student's expired key must not stop every other student's
          // memory from being written.
          console.error(`Chats page update failed for student ${userId}`, error);
        }
      }

      console.log(
        `Chats: ${stale.length} agents checked across ${byStudent.size} students, ` +
          `${changed} pages rewritten, ${recorded} conversations recorded`,
      );
    },
  },
];

async function runJob(job: Job): Promise<void> {
  try {
    await job.run();
  } catch (error) {
    // Never let one job's failure kill the process -- the others still need
    // to run, and a crash loop on the droplet is silent until someone looks.
    console.error(`Job "${job.name}" failed`, error);
  }
}

function start(): void {
  console.log(`Worker started with ${jobs.length} job(s)`);

  for (const job of jobs) {
    void runJob(job);
    setInterval(() => void runJob(job), job.intervalMs);
  }
}

start();
