import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { LlmProvider } from '@contexto/llm';
import { USER_DOC } from '../prompts/documents.js';
import {
  CHATS_DOC_NAME,
  CLASS_PREFIX,
  SCHOOL_DOC_NAME,
  USER_DOC_LIMIT,
  USER_DOC_NAME,
  capDocument,
  listDocuments,
  readDocument,
  writeDocument,
} from './documents.js';
import { academicYearEnd } from './school-doc.js';
import { readGrade } from './grade.js';
import type { Vault } from './vault.js';

/**
 * What is durably true about a student's school life, on one page.
 *
 * Read before every reply, which decides everything about it. It is short
 * because every character is paid for on every turn for as long as it stays,
 * and it is rewritten whole from the pages beneath it rather than added to,
 * because those are ground truth and a document that accumulates ends up
 * describing a student who left two years ago.
 *
 * It is written last, after the class pages and the school page, because it is
 * written FROM them: it is the index to everything else the agent can open. A
 * subject this page fails to name is a subject the agent never learns exists,
 * which makes an omission here more expensive than anywhere else in the vault.
 *
 * It used to be written from counts, and from claims proposed against bounded
 * evidence and challenged by a pass built to break them. That machinery existed
 * because the facts were scattered across four thousand notes and something had
 * to reconcile them. They are not scattered any more -- each has a page of its
 * own, written from its own evidence -- so this pass reads pages and does no
 * inference at all. The one thing it is handed rather than shown is the year
 * group, because that is arithmetic over dates and is done in code.
 */

/** Kept for the paragraph beside the vault, which every existing vault still has. */
const LEGACY_FILE = 'user.md';

/** Re-exported so nothing outside has to know the budget moved to documents.ts. */
export { USER_DOC_LIMIT };

export interface UserDocDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface UserDocOptions {
  vault: Vault;
  userId: string;
  /** The student's own name, when something knows it. */
  name?: string;
}

/**
 * The document, or null if one has never been written.
 *
 * Two places, for as long as it takes every vault to be rebuilt. The document
 * is where it lives now; the paragraph beside the vault is where every vault on
 * disk still has it. Reading the old one when the new one is empty means an
 * agent keeps knowing who its student is across the deploy, and picks up the
 * fuller page on the next build. The writer removes the old file, so this
 * fallback empties itself.
 */
export async function readUserDoc(vault: Vault): Promise<string | null> {
  const document = await readDocument(vault, USER_DOC_NAME);
  if (document && document.body.trim() !== '') return document.body.trim();

  try {
    const text = await readFile(join(vault.directory, LEGACY_FILE), 'utf8');
    return text.trim() === '' ? null : text.trim();
  } catch {
    return null;
  }
}

export async function writeUserDoc(
  { llm }: UserDocDeps,
  { vault, userId, name }: UserDocOptions,
): Promise<string | null> {
  const documents = await listDocuments(vault);
  const classes = documents.filter((doc) => doc.name.startsWith(CLASS_PREFIX));

  /*
   * Nothing to describe.
   *
   * A student who has connected an account with no courses in it gets no page
   * rather than a page saying nothing, because the two are told apart by
   * whether the file exists.
   */
  if (classes.length === 0) return null;

  const school = documents.find((doc) => doc.name === SCHOOL_DOC_NAME);
  const chats = documents.find((doc) => doc.name === CHATS_DOC_NAME);

  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = await academicYearEnd(vault);
  const grade = await readGrade(vault, { today, ...(yearEnd ? { yearEnd } : {}) });

  const answer = await llm.chat(
    {
      messages: [
        { role: 'system', content: USER_DOC.body },
        {
          role: 'user',
          content: [
            name ? `The student is ${name}.` : "The student's name is not known.",
            /*
             * Handed over, not shown.
             *
             * The evidence in the vault says Grade 10, because that is what it
             * said in March. Counting the years that have ended since is
             * arithmetic, done in code, and a writer given the raw statement
             * would confidently repeat last year's answer all summer.
             */
            grade
              ? `They are in Grade ${grade.grade}.` +
                (grade.rolledForward > 0
                  ? ` Their mail says Grade ${grade.stated}, from ${grade.on.slice(0, 10)};` +
                    ` ${grade.rolledForward} academic year(s) have ended since, so it is` +
                    ` ${grade.grade} now. Write ${grade.grade}.`
                  : '')
              : 'Which year they are in is not known: do not guess it from a course name.',
            `Today is ${today}.`,
            '',
            'Their classes, one page each. Link each by the page name shown:',
            ...classes.map((doc) => `- [[${doc.name}]] — ${doc.description}`),
            '',
            school
              ? `Their school has a page, [[${school.name}]]: ${school.description}`
              : 'No school page has been written: do not name a school.',
            chats
              ? `What they have told you is on [[${chats.name}]]: ${chats.description}`
              : 'Nothing has been kept from their conversations yet.',
            '',
            `The page may be at most ${USER_DOC_LIMIT} characters.`,
          ].join('\n'),
        },
      ],
    },
    { userId },
  );

  const body = capDocument(
    typeof answer.content === 'string' ? answer.content : '',
    USER_DOC_LIMIT,
  );
  /*
   * A blank answer must not blank the page.
   *
   * The agent would carry on with no idea who this student is, and nothing
   * would say why -- an empty file and a file that was never written look the
   * same from the outside.
   */
  if (body === '') return readUserDoc(vault);

  await writeDocument(vault, {
    name: USER_DOC_NAME,
    description: 'Who this student is, and what else there is to open',
    body,
  });

  /*
   * And take the old paragraph away, now that there is something better.
   *
   * Leaving it means the fallback above never empties, and a vault carries two
   * answers to the same question with nothing saying which is current.
   */
  await rm(join(vault.directory, LEGACY_FILE), { force: true });

  return body;
}
