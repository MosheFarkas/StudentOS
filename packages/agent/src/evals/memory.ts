import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentActivity } from '@contexto/shared';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import { runAgentTurn } from '../run.js';
import type { AgentRunDeps } from '../run.js';
import { ToolRegistry } from '../tools/registry.js';
import { searchMemory } from '../tools/memory.js';
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

interface Outcome {
  testCase: MemoryCase;
  reply: string;
  passed: boolean;
  why: string;
  searched: boolean;
  queries: { q: string; hits: number }[];
}

async function runCase(apiKey: string, testCase: MemoryCase): Promise<Outcome> {
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

  const categories: MemoryCategory[] = [
    'continuity',
    'extraction',
    'multi-session',
    'update',
    'temporal',
    'abstention',
  ];

  console.log('CATEGORY         PASSED   SEARCHED');
  for (const category of categories) {
    const mine = results.filter((r) => r.testCase.category === category);
    if (mine.length === 0) continue;
    const passed = mine.filter((r) => r.passed).length;
    const searched = mine.filter((r) => r.searched).length;
    console.log(
      category.padEnd(16) +
        `${passed}/${mine.length}`.padStart(6) +
        `${searched}/${mine.length}`.padStart(11),
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const searched = results.filter((r) => r.searched).length;
  console.log(
    `\nTOTAL            ${passed}/${results.length}` +
      `      ${searched}/${results.length}   (${Math.round((passed / results.length) * 100)}% recall, ` +
      `${Math.round((searched / results.length) * 100)}% reached for the tool)`,
  );

  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log('\nFAILURES');
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
