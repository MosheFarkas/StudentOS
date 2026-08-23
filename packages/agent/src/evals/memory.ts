import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentActivity } from '@contexto/shared';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import { runAgentTurn } from '../run.js';
import type { AgentRunDeps } from '../run.js';
import { ToolRegistry } from '../tools/registry.js';
import { searchMemory } from '../tools/memory.js';
import { updateStudentProfile } from '../memory/summarize.js';
import type { ProfileStore } from '../memory/profile.js';
import { queryTerms, rankByTermMatches } from '../memory/search.js';
import type { EpisodicMemory, MemoryStore, RecallOptions } from '../memory/types.js';
import { MEMORY_CASES } from './memory-cases.js';
import { gradeReply, type MemoryCase, type MemoryCategory } from './memory-grader.js';

/**
 * Can the agent remember anything the recency window has dropped?
 *
 *   pnpm --filter @contexto/agent eval:memory
 *
 * Unlike the formatting evals, this runs a whole turn -- real tool loop, real
 * memory_search -- because the thing being measured is whether the agent
 * reaches for its history at all. Calling the model directly would test
 * whether it can read a transcript, which is not the question.
 *
 * Every case buries its fact behind twelve exchanges of ordinary school
 * chatter, so nothing here is answerable from the eight-exchange window. What
 * the score measures is the archival tier doing its job.
 */

/** Mirrors apps/api/src/env.ts -- walk up for .env rather than trusting cwd. */
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

/**
 * The Postgres store's behaviour, in memory.
 *
 * Deliberately mirrors PostgresMemoryStore rather than being convenient: most
 * recent N reversed to read oldest-first, and a case-insensitive substring
 * match ordered newest-first. If this drifts from the real one, the eval
 * measures a store that does not exist.
 */
function seededStore(history: string[], queries: { q: string; hits: number }[]): MemoryStore {
  const base = new Date('2026-08-01T09:00:00Z').getTime();
  const entries: EpisodicMemory[] = history.map((content, i) => ({
    id: `m${i}`,
    agentId: 'eval',
    kind: 'conversation',
    content,
    source: 'agent_run',
    // An hour apart, oldest first, so "recent" means something.
    occurredAt: new Date(base + i * 3_600_000),
    createdAt: new Date(base + i * 3_600_000),
  }));

  return {
    record: async () => entries[0] as EpisodicMemory,
    recall: async (_agentId: string, options: RecallOptions = {}) => ({
      summaries: [],
      recent: entries.slice(-(options.limit ?? 8)),
    }),
    search: async (_agentId: string, query: string, limit = 8) => {
      // Same ranking the Postgres store uses, so the eval measures what ships.
      const hits = rankByTermMatches(entries, queryTerms(query)).slice(0, limit);
      queries.push({ q: query, hits: hits.length });
      return hits;
    },
    unsummarized: async () => [],
    saveSummary: async () => {
      throw new Error('not used by this eval');
    },
  };
}

/**
 * Write a profile from this case's history, with the real writer.
 *
 * Hand-writing the profile would measure a document we invented rather than
 * the one the job produces, which is the only one that will ever exist.
 */
async function profileFor(apiKey: string, testCase: MemoryCase): Promise<string> {
  const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  let written = '';
  const profiles: ProfileStore = {
    read: async () => ({ profile: '', updatedAt: null }),
    save: async (_agentId, profile) => {
      written = profile;
    },
    stale: async () => [],
  };

  await updateStudentProfile(
    { llm: provider, memory: seededStore(testCase.history, []), profiles },
    { agentId: 'eval', userId: 'eval' },
  );
  return written;
}

interface Outcome {
  testCase: MemoryCase;
  reply: string;
  passed: boolean;
  why: string;
  searched: boolean;
  queries: { q: string; hits: number }[];
}

async function runCase(apiKey: string, testCase: MemoryCase, profile?: string): Promise<Outcome> {
  const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  const tools = new ToolRegistry();
  tools.register(searchMemory as never);

  const queries: { q: string; hits: number }[] = [];
  const deps = {
    llm: { chat: provider.chat.bind(provider) },
    memory: seededStore(testCase.history, queries),
    skills: { list: async () => [] },
    tools,
  } as unknown as AgentRunDeps;

  const used: string[] = [];
  const { reply } = await runAgentTurn(deps, {
    userId: 'eval',
    agentId: 'eval',
    purpose: 'keep me on top of my a-levels and stop me missing deadlines',
    message: testCase.question,
    timezone: 'Europe/London',
    ...(profile ? { profile } : {}),
    onActivity: (a: AgentActivity) => {
      if (a.kind === 'tool' && a.name) used.push(a.name);
    },
  } as never);

  const grade = gradeReply(testCase, reply);
  return { testCase, reply, ...grade, searched: used.includes('memory_search'), queries };
}

async function pooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (true) {
        const i = next++;
        const item = items[i];
        if (item === undefined) return;
        out[i] = await fn(item);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  loadDotEnv();

  const apiKey = process.env.PLATFORM_OPENAI_API_KEY;
  if (!apiKey) {
    console.error('PLATFORM_OPENAI_API_KEY is not set. It is read from .env at the repo root.');
    process.exit(1);
  }

  console.log(
    `Model ${PLATFORM_MODEL} | ${MEMORY_CASES.length} cases, each with its fact buried ` +
      'behind the 8-exchange window\n',
  );

  const results = await pooled(MEMORY_CASES, 4, (c) => runCase(apiKey, c));

  // Second arm: the same cases, with a profile the writer produced from the
  // same history. The question stage two has to answer is whether a bounded
  // always-on document beats searching for everything.
  console.log('writing profiles...');
  const profiles = await pooled(MEMORY_CASES, 4, (c) => profileFor(apiKey, c));
  const withProfile = await pooled(
    MEMORY_CASES.map((c, i) => ({ c, profile: profiles[i] ?? '' })),
    4,
    ({ c, profile }) => runCase(apiKey, c, profile),
  );

  const categories: MemoryCategory[] = [
    'continuity',
    'extraction',
    'multi-session',
    'update',
    'temporal',
    'abstention',
    'dense',
  ];

  const score = (rows: Outcome[], category: MemoryCategory) => {
    const mine = rows.filter((r) => r.testCase.category === category);
    return `${mine.filter((r) => r.passed).length}/${mine.length}`;
  };

  console.log('CATEGORY          SEARCH ONLY   + PROFILE');
  for (const category of categories) {
    if (!results.some((r) => r.testCase.category === category)) continue;
    console.log(
      category.padEnd(17) +
        score(results, category).padStart(11) +
        score(withProfile, category).padStart(12),
    );
  }

  const searchedWith = withProfile.filter((r) => r.searched).length;
  console.log(
    `\nreached for memory_search: ${results.filter((r) => r.searched).length}/${results.length}` +
      ` without a profile, ${searchedWith}/${withProfile.length} with one`,
  );
  const avgProfile = Math.round(
    profiles.reduce((n, p) => n + (p?.length ?? 0), 0) / profiles.length,
  );
  console.log(`average profile: ${avgProfile}/1400 characters`);

  const pct = (rows: Outcome[]) =>
    `${rows.filter((r) => r.passed).length}/${rows.length} (${Math.round((rows.filter((r) => r.passed).length / rows.length) * 100)}%)`;
  console.log(`\nTOTAL            ${pct(results).padStart(10)}${pct(withProfile).padStart(13)}`);

  const failures = withProfile.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log('\nSTILL FAILING WITH A PROFILE');
    for (const f of failures) {
      console.log(`  ${f.testCase.id.padEnd(18)} ${f.testCase.category.padEnd(14)} ${f.why}`);
      const shown = f.queries.map((q) => `"${q.q}"->${q.hits}`).join('  ') || 'none';
      console.log(`  ${' '.repeat(18)} queries: ${shown}`);
      console.log(`  ${' '.repeat(18)} "${f.reply.slice(0, 110).replace(/\s+/g, ' ')}"`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
