import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import { runAgentTurn } from '../run.js';
import type { AgentRunDeps } from '../run.js';
import { buildToolRegistry } from '../tools/builtin.js';
import type { PortalSnapshotSource, ToolContext } from '../tools/types.js';
import { USER_DOC_NAME, writeDocument } from '../vault/documents.js';
import { readUserDoc } from '../vault/user-doc.js';
import { Vault } from '../vault/vault.js';

/**
 * Does the agent load a skill when the turn needs one, and only then?
 *
 *   pnpm --filter @contexto/agent eval:skills
 *
 * The skills used to be paragraphs of the system prompt, always present.
 * Now the prompt names them and the model decides. That decision is the
 * whole feature, and it fails silently in both directions: a vault question
 * answered without the reading rules is answered worse, and a sum that loads
 * three skills first is a sum the student waits for.
 *
 * Scored on four things per case. Loaded what it should. Loaded nothing it
 * should not. Called the right tool. Answered.
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

type SkillName = 'browser' | 'vault-reading' | 'vault-writing';

interface Case {
  id: string;
  why: string;
  question: string;
  /** Whether the student has a vault, which decides which skills exist. */
  vault: boolean;
  /** Every one of these must be loaded. */
  load: SkillName[];
  /** None of these may be loaded. 'any' means no skill at all. */
  noLoad: SkillName[] | 'any';
  /** At least one of these must be called. */
  tool?: string[];
  /** None of these may be called. */
  noTool?: string[];
  /** Any one of these in the reply counts as answered. */
  expect?: string[];
  /** For a write: an episode with this event, linking About this note. */
  written?: { event: string; about: string };
}

const CASES: Case[] = [
  {
    id: 'arithmetic-no-vault',
    why: 'nothing here is about the vault or a site, and there is no vault anyway',
    question: 'whats 15% of 240',
    vault: false,
    load: [],
    noLoad: 'any',
    noTool: ['skill_load'],
    expect: ['36'],
  },
  {
    id: 'greeting-with-vault',
    why: 'a vault exists, and the turn still has no use for it',
    question: 'hey hows it going',
    vault: true,
    load: [],
    noLoad: 'any',
    noTool: ['skill_load', 'vault_search', 'vault_open'],
  },
  {
    id: 'what-a-teacher-said',
    why: 'the words are in an episode, and the reading rules say how to get there',
    question: 'what did mrs irwin say about my castle portfolio',
    vault: true,
    load: ['vault-reading'],
    noLoad: ['browser', 'vault-writing'],
    tool: ['vault_search'],
    expect: ['6/8', '6 out of 8', 'six out of eight'],
  },
  {
    id: 'what-a-class-is',
    why: 'the page about a subject says this, and it is opened by name',
    question: 'what is my english class actually like',
    vault: true,
    load: ['vault-reading'],
    noLoad: ['browser', 'vault-writing'],
    tool: ['vault_open'],
    expect: ['irwin', 'essay', 'novel'],
  },
  {
    id: 'a-test-moved',
    why: 'only the student knows this, and the vault should too by the end of the turn',
    question: 'just so you know the chemistry test got moved to friday the 25th',
    vault: true,
    load: ['vault-writing'],
    noLoad: ['browser'],
    tool: ['vault_write'],
    written: { event: 'deadline-changed', about: 'chemistry-test' },
  },
  {
    id: 'check-the-portal',
    why: 'a connected site is the browser skill, and the snapshot already answers it',
    question: 'can you check veracross and see if anything new is due',
    vault: true,
    load: ['browser'],
    noLoad: ['vault-writing'],
    tool: ['portal_read', 'portal_refresh'],
    expect: ['thursday', '18'],
  },
  {
    id: 'a-public-article',
    why: 'a public page is a plain fetch, and waking a laptop for it is the wrong call',
    question: 'whats on https://example.com',
    vault: true,
    load: [],
    noLoad: ['browser', 'vault-writing'],
    tool: ['web_read_link'],
    noTool: ['browser_open'],
    expect: ['example', 'illustrative'],
  },
  {
    id: 'a-page-behind-a-login',
    why: 'only their browser has the session, so only the browser skill applies',
    question:
      'open https://portal.school.example/grades in my browser and tell me if my chemistry grade is in yet',
    vault: true,
    load: ['browser'],
    noLoad: ['vault-writing'],
    tool: ['browser_open'],
    expect: ['84'],
  },
];

/**
 * A linked computer that answers at once.
 *
 * One connected site with a captured page, a refresh that "signs in" and
 * returns it again, and a browse that returns a grades page. Enough for the
 * model to have something real to read, and nothing that touches a network.
 */
function fakePortals(): PortalSnapshotSource {
  const snapshot = {
    portalId: 'veracross',
    origin: 'https://portals.veracross.example',
    capturedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    redacted: false,
    pages: [
      {
        url: 'https://portals.veracross.example/student/assignments',
        title: 'Assignments',
        text: 'Upcoming: Chemistry test, Thursday 18 September. History essay plan, Friday 19 September.',
        components: [],
      },
    ],
  };
  return {
    latest: async () => [snapshot],
    requestRefresh: async () => ({ alreadyPending: false, requestId: 'refresh-1' }),
    requestBrowse: async () => ({ requestId: 'browse-1' }),
    awaitRefresh: async (requestId) => ({
      finished: true,
      outcome: requestId.startsWith('browse') ? 'read' : 'synced',
    }),
    resultOf: async () => ({
      url: 'https://portal.school.example/grades',
      title: 'Grades',
      text: 'Term grades. Chemistry: 84%. Physics: pending. History: 71%.',
      links: [],
    }),
  };
}

async function seedVault(root: string): Promise<Vault> {
  const vault = new Vault(root, 'eval');
  const entity = (name: string, description: string, body: string) =>
    vault.write({ name, kind: 'entity', source: 'classroom', description, body });

  await entity('enriched-english-10', 'Course', 'Enriched English 10, on Google Classroom.');
  await entity('chemistry', 'Course', 'Chemistry, on Google Classroom.');
  await entity(
    'castle-portfolio',
    'Assignment',
    'We Have Always Lived in the Castle Portfolio.\n\nPart of [[enriched-english-10]].',
  );
  await entity(
    'chemistry-test',
    'Assignment',
    'Chemistry test.\n\nPart of [[chemistry]].\nDue: 2026-09-18',
  );

  await vault.write({
    name: '2026-06-18-castle-portfolio-graded',
    kind: 'episode',
    source: 'gmail',
    description: 'Mrs Irwin graded the Castle portfolio 6/8.',
    occurred: '2026-06-18T13:03:00Z',
    actor: 'Mrs Irwin',
    event: 'assignment-graded',
    body: 'Mrs Irwin graded the Castle portfolio and gave it 6/8, saying the close reading was strong and the conclusion rushed.\n\nAbout [[castle-portfolio]]\nIn [[enriched-english-10]]',
  });

  await writeDocument(vault, {
    name: 'class-english',
    description: 'english, as the vault has it',
    academic: true,
    body: [
      '# English',
      '',
      'Enriched English 10, taught by Mrs Irwin.',
      '',
      '## How it works',
      '',
      'Essays and portfolios on the novels studied, marked out of eight.',
    ].join('\n'),
  });
  await writeDocument(vault, {
    name: 'class-chemistry',
    description: 'chemistry, as the vault has it',
    academic: true,
    body: '# Chemistry\n\nTaught by Mr Ali. Tests every few weeks, out of 100.',
  });
  await writeDocument(vault, {
    name: USER_DOC_NAME,
    description: 'Who this student is, and what else there is to open',
    student: 'the student',
    body: [
      '# The student',
      '',
      '## What they study',
      '',
      '- [[class-english]] — English',
      '- [[class-chemistry]] — Chemistry',
    ].join('\n'),
  });

  return vault;
}

interface Outcome {
  testCase: Case;
  reply: string;
  loaded: string[];
  called: string[];
  problems: string[];
}

async function runCase(apiKey: string, testCase: Case): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), 'skill-choice-'));
  try {
    const vault = testCase.vault ? await seedVault(root) : undefined;
    const provider = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });

    /*
     * The real registry, wrapped to see the arguments.
     *
     * onActivity names the tool but not what it was asked for, and the thing
     * this eval scores is which skill skill_load was asked for.
     */
    const tools = buildToolRegistry(null, []);
    const calls: { tool: string; args: string }[] = [];
    const execute = tools.execute.bind(tools);
    tools.execute = async (id: string, raw: string, ctx: ToolContext) => {
      calls.push({ tool: id, args: raw });
      return execute(id, raw, ctx);
    };

    const deps = {
      llm: { chat: provider.chat.bind(provider) },
      memory: {
        recall: async () => ({ summaries: [], recent: [] }),
        record: async () => ({}),
        search: async () => [],
      },
      skills: { list: async () => [] },
      tools,
    } as unknown as AgentRunDeps;

    const { reply } = await runAgentTurn(deps, {
      userId: 'eval',
      agentId: 'eval',
      purpose: 'keep me on top of my a-levels',
      message: testCase.question,
      timezone: 'Europe/London',
      portals: fakePortals(),
      ...(vault ? { vault, about: (await readUserDoc(vault)) ?? undefined } : {}),
    } as never);

    const loaded = [
      ...new Set(
        calls
          .filter((call) => call.tool === 'skill_load')
          .map((call) => {
            try {
              return String((JSON.parse(call.args) as { name?: unknown }).name ?? '');
            } catch {
              return '';
            }
          }),
      ),
    ];
    const called = [...new Set(calls.map((call) => call.tool))];
    const text = reply.toLowerCase().replace(/[‘’]/g, "'");
    const problems: string[] = [];

    for (const skill of testCase.load) {
      if (!loaded.includes(skill)) problems.push(`did not load ${skill}`);
    }
    if (testCase.noLoad === 'any') {
      if (loaded.length > 0) problems.push(`loaded ${loaded.join(', ')} for nothing`);
    } else {
      for (const skill of testCase.noLoad) {
        if (loaded.includes(skill)) problems.push(`loaded ${skill} needlessly`);
      }
    }
    if (testCase.tool && !testCase.tool.some((tool) => called.includes(tool))) {
      problems.push(`called none of ${testCase.tool.join('/')}`);
    }
    for (const tool of testCase.noTool ?? []) {
      if (called.includes(tool)) problems.push(`called ${tool}`);
    }
    if (testCase.expect && !testCase.expect.some((want) => text.includes(want.toLowerCase()))) {
      problems.push(`missing any of: ${testCase.expect.join(' / ')}`);
    }
    if (testCase.written && vault) {
      const episodes = await vault.list('episode');
      const match = episodes.find(
        (note) =>
          note.source === 'student' &&
          note.event === testCase.written?.event &&
          note.body.includes(`About [[${testCase.written?.about}]]`),
      );
      if (!match) {
        problems.push(
          `no student episode with event ${testCase.written.event} About [[${testCase.written.about}]]`,
        );
      }
    }

    return { testCase, reply, loaded, called, problems };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  const apiKey = process.env.PLATFORM_OPENAI_API_KEY;
  if (!apiKey) {
    console.error('PLATFORM_OPENAI_API_KEY is not set. It is read from .env at the repo root.');
    process.exit(1);
  }

  console.log(`Model ${PLATFORM_MODEL} | three skills, loaded on demand\n`);

  const results: Outcome[] = [];
  for (const testCase of CASES) results.push(await runCase(apiKey, testCase));

  console.log('CASE                     LOADED                    CALLED');
  for (const { testCase, loaded, called, problems } of results) {
    console.log(
      testCase.id.padEnd(25) +
        (loaded.join(', ') || 'none').padEnd(26) +
        (called.filter((tool) => tool !== 'skill_load').join(', ') || 'none') +
        (problems.length > 0 ? `  <- ${problems.join('; ')}` : ''),
    );
  }

  const held = results.filter((r) => r.problems.length === 0).length;
  console.log(`\n${held}/${results.length} held`);

  for (const outcome of results.filter((r) => r.problems.length > 0)) {
    console.log(`\n--- ${outcome.testCase.id}: ${outcome.testCase.why}`);
    console.log(outcome.reply.slice(0, 260).replace(/\s+/g, ' '));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
