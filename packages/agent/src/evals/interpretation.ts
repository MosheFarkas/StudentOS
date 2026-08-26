import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiProvider, PLATFORM_MODEL } from '@contexto/llm';
import type { LlmProvider } from '@contexto/llm';
import { Vault } from '../vault/vault.js';
import { askWhoTeaches } from '../vault/evidence.js';
import { understandVault } from '../vault/understand.js';
import {
  INTERPRETATION_CASES,
  STUDENT_DOMAIN,
  type Domain,
  type InterpretationCase,
} from './interpretation-cases.js';

/**
 * How often does the vault say something untrue about a student?
 *
 *   pnpm --filter @contexto/agent eval:interpretation
 *
 * Not a unit test. It spends real money against a real model and answers with
 * rates rather than a pass or a fail, so it lives outside the suite and is run
 * deliberately.
 *
 * Three arms, because "did it get better" is two questions and reporting one
 * number would hide the answer to both:
 *
 *   naive     -- one call, asked who teaches this, given the same evidence.
 *                No candidate list, no abstention contract, no refuter, no
 *                check on what it cites. This is what the product did.
 *   contract  -- the abstention contract and the checks that run in code:
 *                the answer must be a candidate, citations must resolve.
 *                No refuter. The cheap half.
 *   full      -- production: contract plus a second call whose only job is to
 *                break the claim, plus settling.
 *
 * The gap between naive and contract is what a prompt and forty lines of
 * validation are worth. The gap between contract and full is what the second
 * model call buys, which is the part worth knowing before paying for it on
 * every course of every vault.
 *
 * Grading is deterministic. A case has one right answer, and about half of
 * them have `null` for it -- these are shapes where the evidence genuinely
 * does not identify a teacher, so answering at all is the error being counted.
 * Nothing here asks a model whether a model was right.
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
 * The prompt as the product used to work.
 *
 * Reconstructed rather than quoted, because what it replaced was not a prompt
 * at all -- it was a heuristic counting who wrote the most mail, wrapped in a
 * writer that was handed the result and a list of everyone who had ever
 * emailed. This is the same job stated as plainly as it was understood: here
 * is what happened in a course, who teaches it. That question has an answer
 * presupposed in it, which is most of the problem.
 */
const NAIVE = [
  "You are reading a student's school records to work out who teaches a course.",
  'You will be shown everything the records contain about one course.',
  'Reply with just the name of the teacher, and nothing else.',
].join('\n');

type ArmName = 'naive' | 'contract' | 'full';

/** Which settled claim answers each kind of case. */
const RELATION: Record<Domain, string> = {
  role: 'works at the school as',
  kind: 'is',
  teacher: 'taught by',
  running: 'is currently',
};

/**
 * How much ordinary school traffic to bury each case in.
 *
 * The fixtures are four notes and two people, and a real vault is three and a
 * half thousand notes about sixty people and nineteen courses. A pass that
 * only works on the tidy version has not been shown to work: the failure mode
 * the whole design is built against -- a fact going missing among material
 * that looks exactly as relevant -- cannot appear at four notes.
 *
 * The noise is deliberately the damaging kind. Not lorem: more staff, writing
 * more admin, into the same course. Anything less similar would be a lighter
 * test than reality.
 */
const NOISE = Math.max(0, Number(process.env.NOISE ?? 0));

const FILLER = [
  'Reminder that the bus for the away fixture leaves at 3.15 from the front gate.',
  'Photo day is Wednesday. Full uniform, and bring your tie.',
  'The library will be closed on Friday afternoon for stocktaking.',
  'Please make sure lockers are cleared before the end of term.',
  'Lost property is overflowing again. Anything unclaimed goes to charity.',
  'The fire drill this morning went well. Thank you for filing out quietly.',
  'Sign-ups for the winter concert close at the end of the week.',
  'A reminder that phones stay in bags during lessons.',
  'Parents evening bookings open on Monday at 6pm.',
  'The canteen menu has changed for next half term.',
];

const NOISE_STAFF = [
  'Peter Ashworth',
  'Fiona Braithwaite',
  'Ravi Chandran',
  'Helena Dvorak',
  'Marcus Eze',
  'Yuki Fujimoto',
  'Grace Halloran',
  'Tomas Iversen',
];

interface Outcome {
  answered: string | null;
  /** The words limiting the claim, where it carried any. */
  qualifier?: string;
  /** Model calls spent, for the cost column. */
  calls: number;
  /**
   * What the refuter said, when it spoke.
   *
   * Kept because the first run of this eval showed the refuter turning a
   * correct answer into a miss, and "it refused" is not a finding -- the
   * sentence it refused with is.
   */
  refutedWhy?: string;
}

/** Build the case as a real vault, so every arm reads what production reads. */
async function fixture(root: string, testCase: InterpretationCase): Promise<Vault> {
  const vault = new Vault(root, 'eval-student');

  const courses = new Set<string>([testCase.course]);
  for (const episode of testCase.episodes) {
    for (const link of episode.body.matchAll(/\[\[([^\]]+)\]\]/g)) courses.add(link[1] as string);
  }
  for (const course of courses) {
    await vault.write({
      name: course,
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: `${course}, on Google Classroom.`,
    });
  }

  for (const who of NOISE > 0 ? NOISE_STAFF : []) {
    await vault.write({
      name: who.toLowerCase().replace(/\s+/g, '-'),
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: `${who[0]?.toLowerCase() ?? 'x'}${(who.split(' ')[1] ?? '').toLowerCase()}@lcc.ca`,
      body: `${who}, at ${who[0]?.toLowerCase() ?? 'x'}${(who.split(' ')[1] ?? '').toLowerCase()}@lcc.ca.`,
    });
  }

  for (const person of testCase.people) {
    await vault.write({
      name: person.name,
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      ...(person.email ? { externalId: person.email } : {}),
      body: `${person.full ?? person.name}, at ${person.email ?? 'unknown'}.`,
    });
  }

  /*
   * Ordinary traffic, from people who are not the answer, into the same
   * course.
   *
   * Dated inside the case's own window on purpose. Noise is meant to test
   * whether the right evidence can still be found among material that looks
   * exactly as relevant -- not to change what is true. An earlier version
   * dated it all to one October and thereby made a course that had not started
   * look like one that had, so the pass was marked wrong for reading the
   * fixture correctly.
   */
  const when = testCase.episodes
    .map((e, index) => e.on ?? `2026-01-${String(index + 1).padStart(2, '0')}`)
    .sort();
  const from = Date.parse(`${when[0] ?? '2026-01-01'}T09:00:00Z`);
  const to = Date.parse(`${when.at(-1) ?? '2026-01-02'}T09:00:00Z`);

  for (let i = 0; i < NOISE; i++) {
    const who = NOISE_STAFF[i % NOISE_STAFF.length] as string;
    const at = new Date(from + ((to - from) * i) / Math.max(1, NOISE)).toISOString();
    await vault.write({
      name: `noise-${i}`,
      kind: 'episode',
      source: 'classroom',
      description: `${who} wrote.`,
      actor: who,
      occurred: at,
      body: `${who.split(' ')[1] ?? who}. ${FILLER[i % FILLER.length] as string} In [[${testCase.course}]].`,
    });
  }

  for (const [index, episode] of testCase.episodes.entries()) {
    await vault.write({
      name: episode.id,
      kind: 'episode',
      source: 'classroom',
      description: `${episode.actor} wrote.`,
      actor: episode.actor,
      occurred: `${episode.on ?? `2026-01-${String(index + 1).padStart(2, '0')}`}T10:00:00Z`,
      body: episode.body,
    });
  }

  return vault;
}

async function runArm(
  arm: ArmName,
  llm: LlmProvider,
  testCase: InterpretationCase,
): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), 'contexto-eval-'));
  try {
    const vault = await fixture(root, testCase);

    if (arm === 'naive') {
      /*
       * The naive arm only ever knew how to ask one question.
       *
       * That is the honest baseline for the domains added since: there was no
       * pass deciding what a course was or whether it was still going, so
       * there is nothing to compare against and the arm abstains. Inventing a
       * naive version of a question the product never asked would be scoring
       * against a strawman.
       */
      if (testCase.domain !== 'teacher') return { answered: null, calls: 0 };

      /*
       * The narrowing runs for this arm too.
       *
       * It is deterministic and shared, so crediting it to the arms that came
       * after would be measuring the same code twice and calling the
       * difference progress. What separates the arms is only what happens once
       * there is something to ask.
       */
      const question = await askWhoTeaches(vault, testCase.course, {
        studentDomain: STUDENT_DOMAIN,
      });
      if (!question) return { answered: null, calls: 0 };

      const reply = await llm.chat(
        {
          messages: [
            { role: 'system', content: NAIVE },
            {
              role: 'user',
              content: [
                `The course is ${testCase.course}.`,
                '',
                'Everything the records hold about it:',
                ...question.evidence.map((e) => `- ${e.quote}`),
              ].join('\n'),
            },
          ],
          tools: undefined,
        },
        { userId: 'eval' },
      );
      return { answered: nameFrom(reply.content), calls: 1 };
    }

    /*
     * Everything else runs the production pass end to end.
     *
     * An earlier version of this file called the narrowing and the
     * interpretation itself, assembling in the eval what production assembles
     * in understandVault. It drifted, as that arrangement always does, and
     * spent an afternoon reporting a step still broken that had already been
     * fixed. The arms differ by one wrapper around the provider and nothing
     * else.
     */
    const heard: string[] = [];
    let calls = 0;
    const counted = count(
      watchRefuter(arm === 'full' ? llm : withoutRefuter(llm), heard),
      () => (calls += 1),
    );

    const { settled } = await understandVault({ llm: counted }, vault, {
      userId: 'eval',
      studentDomain: STUDENT_DOMAIN,
      ...(testCase.today ? { today: testCase.today } : {}),
    });

    const found = settled.find(
      (c) => c.subject === testCase.subject && c.relation === RELATION[testCase.domain],
    );
    const why = heard.at(-1);
    return {
      answered: found?.object ?? null,
      calls,
      ...(found?.qualifier ? { qualifier: found.qualifier } : {}),
      ...(why && !found ? { refutedWhy: why } : {}),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Count every call the pass actually makes, rather than assuming a number. */
function count(llm: LlmProvider, tick: () => void): LlmProvider {
  return {
    ...llm,
    chat: async (request, ctx) => {
      tick();
      return llm.chat(request, ctx);
    },
  } as LlmProvider;
}

/**
 * The same provider, with the refutation call short-circuited to "not refuted".
 *
 * Detected by the document the call carries rather than by counting calls: a
 * proposal that abstains never reaches the refuter at all, so a call index
 * would drift out of step on exactly the cases that matter most.
 */
function withoutRefuter(llm: LlmProvider): LlmProvider {
  return {
    ...llm,
    chat: async (request, ctx) => {
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      if (system.includes('Trying to knock a claim down')) {
        return { content: '{"refuted": false}', toolCalls: [] } as never;
      }
      return llm.chat(request, ctx);
    },
  } as LlmProvider;
}

/** Record what the refutation call said, without changing what it does. */
function watchRefuter(llm: LlmProvider, heard: string[]): LlmProvider {
  return {
    ...llm,
    chat: async (request, ctx) => {
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      const reply = await llm.chat(request, ctx);
      if (system.includes('Trying to knock a claim down')) {
        const why = /"why"\s*:\s*"([^"]+)"/.exec(reply.content)?.[1];
        if (why) heard.push(why);
      }
      return reply;
    },
  } as LlmProvider;
}

/**
 * A name out of a free-text reply.
 *
 * The naive arm has no format to obey, which is the point of it -- so this is
 * generous on purpose. Reading "I cannot tell" as an answer would flatter the
 * arms that came after it.
 */
function nameFrom(reply: string): string | null {
  const text = reply.trim().replace(/^["'`]+|["'`.]+$/g, '');
  if (text === '') return null;
  if (
    /\b(unknown|unclear|cannot|can't|not (?:enough|clear|possible|stated)|no (?:teacher|one|name)|unable|insufficient|none)\b/i.test(
      text,
    )
  ) {
    return null;
  }
  const line = text.split('\n')[0] as string;
  return line.length > 60
    ? null
    : line.replace(/^(?:M|Mme|Mr|Mrs|Ms|Madame|Monsieur|Dr)\.?\s+/i, '');
}

type Verdict = 'correct' | 'hallucinated' | 'missed' | 'abstained';

const MARK: Record<Verdict, string> = {
  correct: '✓',
  abstained: '·',
  missed: '?',
  hallucinated: '✗',
};

/** Deterministic, and unkind on purpose. */
function grade(testCase: InterpretationCase, outcome: Outcome): Verdict {
  const same = (a: string, b: string) =>
    a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

  const { answered, qualifier } = outcome;
  if (answered === null) return testCase.expect === null ? 'abstained' : 'missed';
  if (testCase.expect === null) return 'hallucinated';

  // A different name is a hallucination, not a near miss. There is no partial
  // credit for a wrong teacher.
  if (!same(answered, testCase.expect)) return 'hallucinated';

  /*
   * The right name, stated more flatly than the evidence allows, is still a
   * claim the vault should not be making.
   */
  if (
    testCase.expectQualifier &&
    !(qualifier ?? '').toLowerCase().includes(testCase.expectQualifier.toLowerCase())
  ) {
    return 'hallucinated';
  }
  return 'correct';
}

function bar(value: number, width = 20): string {
  const filled = Math.round(value * width);
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

/** Run with a bounded number in flight, keeping results in order. */
async function pool<T, R>(items: readonly T[], width: number, run: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) {
        out[i] = await run(items[i] as T);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  loadDotEnv();

  const apiKey = process.env.PLATFORM_OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      'PLATFORM_OPENAI_API_KEY is not set.\n' +
        'It is read from .env at the repo root, the same file the API uses.',
    );
    process.exit(1);
  }

  /*
   * Repeats, because one run of a corpus this size is one sample.
   *
   * An early run of this eval showed the refutation step costing a correct
   * answer and preventing nothing, which is a finding worth acting on and
   * exactly the kind of thing a single sample invents. A case that lands
   * differently across trials is unstable, and that is reported rather than
   * averaged away.
   */
  const trials = Math.max(1, Number(process.env.TRIALS ?? 3));
  const width = Math.max(1, Number(process.env.CONCURRENCY ?? 6));

  const llm = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  const arms: ArmName[] = (process.env.ARMS?.split(',') as ArmName[]) ?? [
    'naive',
    'contract',
    'full',
  ];

  const byDomain = (domain: Domain) => INTERPRETATION_CASES.filter((c) => c.domain === domain);
  const domains: Domain[] = ['role', 'kind', 'teacher', 'running'];

  console.log(
    `Model ${PLATFORM_MODEL} | ${INTERPRETATION_CASES.length} cases across ${domains.length} ` +
      `kinds of reasoning | ${arms.length} arms x ${trials} trials | noise ${NOISE}\n`,
  );
  for (const domain of domains) {
    const cases = byDomain(domain);
    const answerable = cases.filter((c) => c.expect !== null).length;
    console.log(
      `  ${domain.padEnd(8)} ${String(cases.length).padStart(2)} cases ` +
        `(${answerable} answerable, ${cases.length - answerable} not)`,
    );
  }
  console.log('');

  const seen = new Map<ArmName, Map<string, Verdict[]>>();
  const spent = new Map<ArmName, number>();
  const refusals = new Map<string, string[]>();

  for (const arm of arms) {
    const verdicts = new Map<string, Verdict[]>();
    let calls = 0;

    for (let trial = 0; trial < trials; trial++) {
      process.stdout.write(`${arm.padEnd(9)} ${trial + 1}/${trials}  `);
      const outcomes = await pool(INTERPRETATION_CASES, width, async (testCase) => {
        try {
          return await runArm(arm, llm, testCase);
        } catch (error) {
          console.error(`\n  ${testCase.id} failed:`, error);
          return { answered: null, calls: 0 } as Outcome;
        }
      });

      for (const [index, outcome] of outcomes.entries()) {
        const testCase = INTERPRETATION_CASES[index] as InterpretationCase;
        calls += outcome.calls;
        const verdict = grade(testCase, outcome);
        verdicts.set(testCase.id, [...(verdicts.get(testCase.id) ?? []), verdict]);
        if (outcome.refutedWhy && verdict !== 'abstained') {
          refusals.set(testCase.id, [...(refusals.get(testCase.id) ?? []), outcome.refutedWhy]);
        }
        process.stdout.write(MARK[verdict]);
      }
      console.log('');
    }

    seen.set(arm, verdicts);
    spent.set(arm, calls);
  }

  console.log('\n  ✓ right   · rightly said nothing   ? missed a knowable answer   ✗ WRONG\n');

  const marks = (arm: ArmName, cases: readonly InterpretationCase[]) =>
    cases.flatMap((c) => seen.get(arm)?.get(c.id) ?? []);
  const rate = (list: Verdict[], of: Verdict) =>
    list.length === 0 ? 0 : list.filter((v) => v === of).length / list.length;

  console.log('arm        hallucination rate    right   silent   missed   calls');
  for (const arm of arms) {
    const all = marks(arm, INTERPRETATION_CASES);
    const answerable = INTERPRETATION_CASES.filter((c) => c.expect !== null).length * trials;
    console.log(
      `${arm.padEnd(10)} ${bar(rate(all, 'hallucinated'))} ` +
        `${(rate(all, 'hallucinated') * 100).toFixed(0).padStart(3)}%` +
        `${`${all.filter((v) => v === 'correct').length}/${answerable}`.padStart(9)}` +
        `${String(all.filter((v) => v === 'abstained').length).padStart(9)}` +
        `${String(all.filter((v) => v === 'missed').length).padStart(9)}` +
        `${String(spent.get(arm) ?? 0).padStart(8)}`,
    );
  }

  /*
   * Per kind of reasoning, because one number hides the answer.
   *
   * A pass that names teachers well and cannot tell a house from a subject
   * averages out to something respectable, and the average is what would get
   * shipped.
   */
  const best = arms.at(-1) as ArmName;
  console.log(`\nwhere ${best} stands, by kind of reasoning:\n`);
  console.log('reasoning   hallucination        right   silent   missed');
  for (const domain of domains) {
    const cases = byDomain(domain);
    const list = marks(best, cases);
    const answerable = cases.filter((c) => c.expect !== null).length * trials;
    console.log(
      `${domain.padEnd(11)} ${bar(rate(list, 'hallucinated'))} ` +
        `${(rate(list, 'hallucinated') * 100).toFixed(0).padStart(3)}%` +
        `${`${list.filter((v) => v === 'correct').length}/${answerable}`.padStart(9)}` +
        `${String(list.filter((v) => v === 'abstained').length).padStart(9)}` +
        `${String(list.filter((v) => v === 'missed').length).padStart(9)}`,
    );
  }

  console.log('\nper case (one mark per trial):\n');
  const width2 = Math.max(...INTERPRETATION_CASES.map((c) => c.id.length));
  console.log(`${'case'.padEnd(width2)}  ${arms.map((a) => a.padEnd(trials + 3)).join('')}`);
  for (const domain of domains) {
    for (const testCase of byDomain(domain)) {
      const row = arms
        .map((arm) =>
          (seen.get(arm)?.get(testCase.id) ?? [])
            .map((v) => MARK[v])
            .join('')
            .padEnd(trials + 3),
        )
        .join('');
      console.log(`${testCase.id.padEnd(width2)}  ${row}`);
    }
  }

  const unstable = INTERPRETATION_CASES.filter((c) =>
    arms.some((arm) => new Set(seen.get(arm)?.get(c.id) ?? []).size > 1),
  );
  if (unstable.length > 0) {
    console.log(`\nunstable across trials: ${unstable.map((c) => c.id).join(', ')}`);
  }

  /*
   * Everything the best arm still gets wrong, with the reason where there was
   * one. This is the list the next round of work comes from.
   */
  const wrong = INTERPRETATION_CASES.filter((c) =>
    (seen.get(best)?.get(c.id) ?? []).some((v) => v === 'hallucinated' || v === 'missed'),
  );
  if (wrong.length > 0) {
    console.log(`\nstill wrong in ${best}:\n`);
    for (const testCase of wrong) {
      const got = (seen.get(best)?.get(testCase.id) ?? []).map((v) => MARK[v]).join('');
      console.log(
        `  ${testCase.id} [${testCase.domain}] ${got}  expected ${testCase.expect ?? 'nobody'}`,
      );
      console.log(`    ${testCase.trap}`);
      for (const why of refusals.get(testCase.id) ?? []) console.log(`    refuter said: ${why}`);
      console.log('');
    }
  }
}

await main();
