import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import { buildSystemPrompt, buildTurnContext, buildUserMessage } from '../run.js';
import type { EpisodicMemory } from '../memory/types.js';
import type { SkillRegistry } from '../skills/types.js';

/**
 * What it costs to keep volatile text in the system prompt.
 *
 *   pnpm --filter @contexto/agent eval:cache
 *
 * The finding this exists to hold onto: on the Responses API the system prompt
 * is cached as a whole blob keyed on its exact text, not prefix-matched.
 * Appending six tokens to a 3,613-token prompt took `cached_tokens` from 3,610
 * to zero. So while the clock and the memory block lived in the system prompt,
 * every turn rewrote it and nothing in it ever cached -- not the sections below
 * the clock, the whole thing.
 *
 * Method. Caching pays on a conversation's second turn: the first writes, the
 * second reads. Each arm sends two turns, the second carrying one more
 * remembered exchange, exactly as a real conversation would. What we read is
 * `cachedInputTokens` on turn two.
 *
 * Each arm is salted with a unique id so the arms cannot read each other's
 * cache and report someone else's win as their own.
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

const PURPOSE = 'keep me on top of my a-levels and stop me missing deadlines';
const TIMEZONE = 'Europe/London';
const QUESTION = 'what is the capital of australia';

const SKILLS = [
  {
    name: 'chase-a-missing-mark',
    description: 'Find out why a submitted assignment has no grade yet',
    instructions:
      'Check Classroom for the submission state first. If it is turned in and ungraded, ' +
      'look at the due date and the teacher announcements before drafting anything. Only ' +
      'suggest emailing the teacher if it has been more than a fortnight.',
  },
  {
    name: 'build-a-revision-plan',
    description: 'Turn an exam timetable into a day-by-day revision schedule',
    instructions:
      'Work backwards from each exam date. Reserve the last two days before any paper for ' +
      'past questions rather than new content, and never schedule more than two subjects ' +
      'in one evening.',
  },
] as unknown as Awaited<ReturnType<SkillRegistry['list']>>;

function memory(count: number): { summaries: never[]; recent: EpisodicMemory[] } {
  const now = new Date('2026-08-22T18:00:00Z');
  return {
    summaries: [],
    recent: Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      agentId: 'eval',
      kind: 'conversation' as EpisodicMemory['kind'],
      content:
        `Student: question number ${i} about chemistry coursework\n` +
        'Agent: a reply of ordinary length about the coursework, roughly what a real turn produces',
      source: 'agent_run',
      occurredAt: now,
      createdAt: now,
    })),
  };
}

interface Turn {
  system: string;
  user: string;
}

interface Arm {
  name: string;
  note: string;
  turns: [Turn, Turn];
}

function arms(): Arm[] {
  const salt = () => `Session ${randomUUID()}.\n\n`;
  const system = buildSystemPrompt(PURPOSE, SKILLS);
  const context = (n: number) => buildTurnContext(memory(n), TIMEZONE);

  const beforeSalt = salt();
  const afterSalt = salt();

  return [
    {
      name: 'before',
      note: 'clock + memory inside the system prompt',
      turns: [
        { system: `${beforeSalt}${system}\n\n${context(6)}`, user: QUESTION },
        { system: `${beforeSalt}${system}\n\n${context(7)}`, user: QUESTION },
      ],
    },
    {
      name: 'after',
      note: 'system prompt static, volatile in the turn',
      turns: [
        { system: afterSalt + system, user: buildUserMessage(context(6), QUESTION) },
        { system: afterSalt + system, user: buildUserMessage(context(7), QUESTION) },
      ],
    },
  ];
}

async function main(): Promise<void> {
  loadDotEnv();

  const apiKey = process.env.PLATFORM_OPENAI_API_KEY;
  if (!apiKey) {
    console.error('PLATFORM_OPENAI_API_KEY is not set. It is read from .env at the repo root.');
    process.exit(1);
  }

  const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  const ask = async (turn: Turn) => {
    const response = await provider.chat(
      {
        messages: [
          { role: 'system', content: turn.system },
          { role: 'user', content: turn.user },
        ],
      },
      { userId: 'eval', agentId: 'eval' },
    );
    return response.usage;
  };

  console.log(`Model ${PLATFORM_MODEL}. Two turns per arm; turn two is what caching pays for.\n`);

  const results: { arm: Arm; input: number; cached: number }[] = [];
  for (const arm of arms()) {
    // Sequential, same arm first: turn two can only read what turn one wrote.
    await ask(arm.turns[0]);
    const usage = await ask(arm.turns[1]);
    results.push({ arm, input: usage.inputTokens, cached: usage.cachedInputTokens });
  }

  console.log('ARM     WHERE THE VOLATILE TEXT LIVES              INPUT   CACHED    HIT');
  for (const { arm, input, cached } of results) {
    const pct = input > 0 ? Math.round((cached / input) * 100) : 0;
    console.log(
      arm.name.padEnd(8) +
        arm.note.padEnd(44) +
        String(input).padStart(5) +
        String(cached).padStart(9) +
        `${String(pct).padStart(6)}%`,
    );
  }

  const before = results.find((r) => r.arm.name === 'before');
  const after = results.find((r) => r.arm.name === 'after');
  if (before && after) {
    console.log(
      `\n${after.cached - before.cached} more tokens served from cache on every turn after the first.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
