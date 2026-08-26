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
       * The narrowing runs for this arm too.
       *
       * It is deterministic and shared, so crediting it to the arms that came
       * after would be measuring the same code twice and calling the
       * difference progress. What separates the arms is only what happens once
       * there is something to ask.
       */
      const question = await askWhoTeaches(vault, testCase.course, STUDENT_DOMAIN);
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
    });

    const teacher = settled.find(
      (c) => c.subject === testCase.course && c.relation === 'taught by',
    );
    const why = heard.at(-1);
    return {
      answered: teacher?.object ?? null,
      calls,
      ...(teacher?.qualifier ? { qualifier: teacher.qualifier } : {}),
      ...(why && !teacher ? { refutedWhy: why } : {}),
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
   * Repeats, because one run of twelve cases is one sample.
   *
   * The first run of this eval showed the refutation step costing a correct
   * answer and preventing nothing, which is a finding worth acting on and
   * exactly the kind of thing a single sample invents. A case that lands
   * differently across trials is unstable, and that is reported rather than
   * averaged away.
   */
  const trials = Math.max(1, Number(process.env.TRIALS ?? 3));

  const llm = new OpenAiProvider({ apiKey, model: PLATFORM_MODEL });
  const arms: ArmName[] = ['naive', 'contract', 'full'];
  const knowable = INTERPRETATION_CASES.filter((c) => c.expect !== null).length;

  console.log(
    `Model ${PLATFORM_MODEL} | ${INTERPRETATION_CASES.length} cases ` +
      `(${knowable} answerable, ${INTERPRETATION_CASES.length - knowable} not) ` +
      `x ${arms.length} arms x ${trials} trials\n`,
  );

  const seen = new Map<ArmName, Map<string, Verdict[]>>();
  const spent = new Map<ArmName, number>();
  const refusals = new Map<string, string[]>();

  for (const arm of arms) {
    const verdicts = new Map<string, Verdict[]>();
    let calls = 0;

    for (let trial = 0; trial < trials; trial++) {
      process.stdout.write(`${arm.padEnd(9)} ${trial + 1}/${trials}  `);
      for (const testCase of INTERPRETATION_CASES) {
        let outcome: Outcome;
        try {
          outcome = await runArm(arm, llm, testCase);
        } catch (error) {
          console.error(`\n  ${testCase.id} failed:`, error);
          outcome = { answered: null, calls: 0 };
        }
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

  const total = INTERPRETATION_CASES.length * trials;
  const tally = (arm: ArmName, verdict: Verdict) =>
    [...(seen.get(arm)?.values() ?? [])].flat().filter((v) => v === verdict).length;

  console.log('arm        hallucination rate    right   silent   missed   calls');
  for (const arm of arms) {
    const wrong = tally(arm, 'hallucinated');
    const rate = wrong / total;
    console.log(
      `${arm.padEnd(10)} ${bar(rate)} ${(rate * 100).toFixed(0).padStart(3)}%` +
        `${`${tally(arm, 'correct')}/${knowable * trials}`.padStart(9)}` +
        `${String(tally(arm, 'abstained')).padStart(9)}` +
        `${String(tally(arm, 'missed')).padStart(9)}` +
        `${String(spent.get(arm) ?? 0).padStart(8)}`,
    );
  }

  console.log('\nper case (one mark per trial):\n');
  const width = Math.max(...INTERPRETATION_CASES.map((c) => c.id.length));
  console.log(
    `${'case'.padEnd(width)}  naive${' '.repeat(trials)}contract${' '.repeat(trials)}full`,
  );
  for (const testCase of INTERPRETATION_CASES) {
    const marks = (arm: ArmName) =>
      (seen.get(arm)?.get(testCase.id) ?? []).map((v) => MARK[v]).join('');
    console.log(
      `${testCase.id.padEnd(width)}  ${marks('naive').padEnd(trials + 4)} ` +
        `${marks('contract').padEnd(trials + 7)} ${marks('full')}`,
    );
  }

  /*
   * A case that lands differently across its own trials is telling us the
   * measurement is noisy there, not that an arm is better. Reporting the mean
   * without this would turn a coin flip into a conclusion.
   */
  const unstable = INTERPRETATION_CASES.filter((c) =>
    arms.some((arm) => new Set(seen.get(arm)?.get(c.id) ?? []).size > 1),
  );
  if (unstable.length > 0) {
    console.log(`\nunstable across trials: ${unstable.map((c) => c.id).join(', ')}`);
  }

  const moved = INTERPRETATION_CASES.filter((c) => {
    const worst = (arm: ArmName) =>
      (seen.get(arm)?.get(c.id) ?? []).filter((v) => v === 'hallucinated').length;
    const right = (arm: ArmName) =>
      (seen.get(arm)?.get(c.id) ?? []).filter((v) => v === 'correct' || v === 'abstained').length;
    return worst('naive') !== worst('full') || right('contract') !== right('full');
  });

  if (moved.length > 0) {
    console.log('\nwhere the arms disagree:\n');
    for (const testCase of moved) {
      const line = (arm: ArmName) =>
        `${arm.padEnd(9)} ${(seen.get(arm)?.get(testCase.id) ?? []).map((v) => MARK[v]).join('')}`;
      console.log(`  ${testCase.id}  (expected ${testCase.expect ?? 'nobody'})`);
      for (const arm of arms) console.log(`    ${line(arm)}`);
      console.log(`    ${testCase.trap}`);
      for (const why of refusals.get(testCase.id) ?? []) {
        console.log(`    refuter said: ${why}`);
      }
      console.log('');
    }
  }
}

await main();
