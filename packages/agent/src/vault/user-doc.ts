import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmProvider } from '@contexto/llm';
import { USER_DOC } from '../prompts/documents.js';
import { capProfile } from '../memory/profile.js';
import { vaultDigest } from './digest.js';
import type { Vault } from './vault.js';

/**
 * What is durably true about a student's school life, in a paragraph.
 *
 * Read before every reply, which decides everything about it. It is short
 * because every character is paid for on every turn for as long as it stays.
 * It is rewritten whole from the vault rather than added to, because the vault
 * is ground truth and a document that accumulates ends up describing a student
 * who left two years ago. And it is written from counts rather than from the
 * notes themselves, because three and a half thousand notes will not fit in a
 * prompt and would cost a fortune per rebuild if they did.
 *
 * Kept beside the vault rather than inside it: it is not a note, it has no
 * links, and it should not appear in a graph of what the student's school
 * looks like. It is what the agent knows before it looks anything up.
 *
 * This is a different document from the conversation profile, deliberately.
 * They have different sources and different lifetimes -- this one is rewritten
 * wholesale when a term changes, that one accumulates as somebody talks -- and
 * a single writer holding both would discard whichever half it could not see.
 */

/** Read on every turn, so the budget is smaller than the conversation profile's. */
export const USER_DOC_LIMIT = 1200;

const FILE = 'user.md';

export interface UserDocDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface UserDocOptions {
  vault: Vault;
  userId: string;
  /** The student's own name, when something knows it. */
  name?: string;
  /**
   * The domains their school sends mail from.
   *
   * The only fact in the vault that identifies the school at all. The name of
   * the place was previously arriving by accident, through a list of everyone
   * who had ever emailed -- the same list that produced an invented teacher.
   */
  schoolDomains?: string[];
}

/** The document, or null if one has never been written. */
export async function readUserDoc(vault: Vault): Promise<string | null> {
  try {
    const text = await readFile(join(vault.directory, FILE), 'utf8');
    return text.trim() === '' ? null : text.trim();
  } catch {
    return null;
  }
}

export async function writeUserDoc(
  { llm }: UserDocDeps,
  { vault, userId, name, schoolDomains }: UserDocOptions,
): Promise<string | null> {
  // The student's own domain tells staff from classmates. See digest.ts.
  const digest = await vaultDigest(vault, schoolDomains?.[0]);
  if (digest.courses.length === 0) return null;

  const answer = await llm.chat(
    {
      messages: [
        { role: 'system', content: USER_DOC.body },
        {
          role: 'user',
          content: [
            name ? `The student is ${name}.` : "The student's name is not known.",
            `Today is ${digest.today}.`,
            `Their vault covers ${digest.from ?? 'an unknown period'}${
              digest.to ? ` to ${digest.to}` : ''
            }.`,
            '',
            /*
             * A course, one bit, and its teacher if that course names one.
             *
             * The first version handed over work counts and a loose list of
             * everyone who had ever emailed. It spent half the document on
             * figures that change nothing, and it paired that list with the
             * courses and named a teacher who does not teach him. A teacher
             * now travels attached to the course whose announcements name
             * them, or not at all.
             */
            'Their courses. "sets work" is a hint that it is a taught subject',
            'rather than a club, and only a hint. "last activity" is the most',
            'recent thing that happened in it and "last due" the final deadline',
            'it set -- together they say whether a course is running or over:',
            ...digest.courses.map(
              (c) =>
                `${c.name} — ${c.setsWork ? 'sets work' : 'sets no work'}` +
                (c.teacher ? `, taught by ${c.teacher}` : ', teacher unknown') +
                `, last activity ${c.lastSeen ?? 'never'}, last due ${c.lastDue ?? 'never'}`,
            ),
            '',
            "Where a teacher is named above it was read from that course's own",
            'announcements, and you must include it. Where it says unknown,',
            'nothing knows: do not supply one from anywhere else.',
            '',
            ...(schoolDomains?.length
              ? [
                  `Their school sends mail from ${schoolDomains.join(' and ')}. Name the school`,
                  'only if you actually recognise it from that; otherwise leave it out.',
                  '',
                ]
              : []),
            `The document may be at most ${USER_DOC_LIMIT} characters.`,
          ].join('\n'),
        },
      ],
      tools: undefined,
    },
    { userId },
  );

  const written = tidy(answer.content);
  /*
   * A blank answer must not blank the document.
   *
   * The agent would carry on with no idea who this student is, and nothing
   * would say why -- an empty file and a file that was never written look the
   * same from the outside.
   */
  if (written === '') return readUserDoc(vault);

  await writeFile(join(vault.directory, FILE), `${written}\n`, 'utf8');
  return written;
}

/**
 * Prose only, and inside the budget.
 *
 * The instructions rule out markup, and a model mostly obeys them. Mostly is
 * not good enough for something that sits in every system prompt for a term,
 * so a stray heading is taken out here rather than left to be noticed.
 */
function tidy(text: string): string {
  const prose = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /*
   * Same sentence-boundary cut as the conversation profile, at this
   * document's own budget. Capping at the profile's limit and then slicing to
   * this one would undo the sentence boundary and leave the agent reading half
   * a fact and believing it.
   */
  return capProfile(prose, USER_DOC_LIMIT);
}
