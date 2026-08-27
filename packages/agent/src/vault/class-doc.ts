import { createHash } from 'node:crypto';
import type { LlmProvider } from '@contexto/llm';
import { CLASS_DOC } from '../prompts/documents.js';
import {
  CLASS_DOC_LIMIT,
  capDocument,
  classDocName,
  listDocuments,
  readDocument,
  writeDocument,
} from './documents.js';
import { buildGraph } from './graph.js';
import { renderNotes } from './render.js';
import type { CourseVerdict } from './courses.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * A page per class, written from the notes filed under it.
 *
 * The layer that makes a vault answerable. Four thousand notes will not fit in
 * a prompt and nobody would read them if they did; one page per subject can be
 * opened when a question turns out to be about that subject, and says what
 * taking it is actually like.
 *
 * One page per SUBJECT, not per Classroom room. This student has two French
 * teachers in two rooms and one French class, and a vault that answers "which
 * French?" has failed at the only question it was asked.
 *
 * The notes stay. This page summarises them; it does not replace them. An
 * assignment, a file, a project is still its own note and still reachable
 * through search -- what this adds is a way in that does not require knowing
 * what to search for.
 */

export interface ClassDocDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface ClassDocOptions {
  vault: Vault;
  /** What the filter decided: which courses survive, and which subject each is. */
  verdicts: CourseVerdict[];
  userId: string;
}

export interface ClassDocResult {
  written: number;
  /** Pages whose sources had not changed since they were last written. */
  skipped: number;
  /** Pages taken away, because the student no longer takes that subject. */
  removed: number;
}

/**
 * How much of a course to put in front of the writer.
 *
 * A year of a busy subject is more than a page needs and more than a prompt
 * should carry. What a course *is* shows in its units and a sample of what it
 * asks for; the rest is detail the page is not allowed to mention anyway,
 * because it expires.
 */
const SHOWN = 60;

export async function writeClassDocs(
  { llm }: ClassDocDeps,
  { vault, verdicts, userId }: ClassDocOptions,
): Promise<ClassDocResult> {
  const kept = verdicts.filter((verdict) => verdict.keep);

  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);
  const courses = entities.filter((note) => note.description === 'Course');

  /**
   * The course notes a verdict is about, matched on the title the importer wrote.
   *
   * All of them, not the first. A school can give two rooms of one subject the
   * same name -- the importer already copes, naming the second `french-2` --
   * and matching on the title alone would find one of the two and quietly leave
   * everything filed under the other out of the page describing the subject.
   */
  const notesFor = (courseName: string): VaultNote[] =>
    courses.filter((note) => titleOf(note) === courseName);

  /** subject -> the course notes it merges. */
  const subjects = new Map<string, { notes: VaultNote[]; academic: boolean }>();
  for (const verdict of kept) {
    const found = notesFor(verdict.course);
    if (found.length === 0) continue;

    const already = subjects.get(verdict.subject);
    if (already) {
      // Two verdicts naming one room must not put it in the group twice.
      const seen = new Set(already.notes.map((note) => note.name));
      already.notes.push(...found.filter((note) => !seen.has(note.name)));
    } else {
      subjects.set(verdict.subject, { notes: found, academic: verdict.academic });
    }
  }

  const { nodes } = await buildGraph(vault);
  const byName = new Map([...entities, ...episodes].map((note) => [note.name, note]));

  const result: ClassDocResult = { written: 0, skipped: 0, removed: 0 };
  const wanted = new Set<string>();

  for (const [subject, { notes, academic }] of subjects) {
    const name = classDocName(subject);
    wanted.add(name);

    const homes = new Set(notes.map((note) => note.name));
    const cluster = nodes
      .filter((node) => node.cluster && homes.has(node.cluster))
      .map((node) => byName.get(node.name))
      .filter((note): note is VaultNote => note !== undefined);

    /*
     * A fingerprint of everything the page is written from.
     *
     * Names and descriptions rather than whole bodies: a body changes when a
     * file is re-read and says the same thing, and rewriting the page for that
     * is what this exists to avoid.
     */
    const hash = fingerprint([...notes, ...cluster]);
    const existing = await readDocument(vault, name);
    if (existing?.sourceHash === hash) {
      result.skipped += 1;
      continue;
    }

    const answer = await llm.chat(
      {
        messages: [
          { role: 'system', content: CLASS_DOC.body },
          { role: 'user', content: brief(subject, academic, notes, cluster) },
        ],
      },
      { userId },
    );

    const body = capDocument(
      typeof answer.content === 'string' ? answer.content : '',
      CLASS_DOC_LIMIT,
    );
    /*
     * A blank answer must not blank a page.
     *
     * An empty document and one that was never written look the same from the
     * outside, and the agent would carry on with nothing to say about a subject
     * with no sign of why.
     */
    if (body === '') continue;

    await writeDocument(vault, {
      name,
      description: academic
        ? `${subject}, as the vault has it`
        : `${subject} -- not a subject they take, but something they do`,
      body,
      sourceHash: hash,
    });
    result.written += 1;
  }

  /*
   * And take away the pages for subjects that are no longer theirs.
   *
   * A class document outlives the course it describes unless something removes
   * it, and a page about last year's history is exactly what this whole change
   * exists to get out of the vault.
   *
   * Not when there were no verdicts at all, though. That is Classroom being
   * briefly unreachable, not a student dropping every subject they take, and
   * the two look identical from here -- so the one that deletes nothing wins.
   */
  if (verdicts.length === 0) return result;

  for (const document of await listDocuments(vault)) {
    if (!document.name.startsWith('class-') || wanted.has(document.name)) continue;
    if (await vault.remove('document', document.name)) result.removed += 1;
  }

  return result;
}

/** The title the importer wrote on the first line, up to the comma. */
function titleOf(note: VaultNote): string {
  return (note.body.split('\n')[0] ?? '').split(',')[0]?.trim() ?? '';
}

function fingerprint(notes: VaultNote[]): string {
  const parts = notes
    .map((note) => `${note.name}:${note.description}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

/** Everything the writer is allowed to work from, and nothing else. */
function brief(
  subject: string,
  academic: boolean,
  courses: VaultNote[],
  cluster: VaultNote[],
): string {
  const of = (description: string) => cluster.filter((note) => note.description === description);

  const people = of('Person');

  return [
    `The subject is ${subject}.`,
    academic
      ? 'It is a taught subject.'
      : 'It is not a taught subject: it is a club, team or group they belong to. Describe it as that.',
    courses.length > 1
      ? `It is taught in ${courses.length} Classroom rooms, which are one class to this student. Write one page covering all of them.`
      : '',
    '',
    'Names you may link to, and no others:',
    ...[...courses, ...cluster].slice(0, SHOWN * 2).map((note) => `- ${note.name}`),
    '',
    people.length > 0
      ? 'The people who appear in this subject. Only one of these can be its teacher:'
      : 'Nobody is recorded against this subject. Say the teacher is not recorded.',
    ...people.map((note) => `- [[${note.name}]] ${note.description}`),
    '',
    'The course, and what is filed under it:',
    '',
    /*
     * Through the same renderer as everything else.
     *
     * These notes are a teacher's words. Nothing about being on the way to a
     * document rather than to a reply makes them safe, and this is the pass
     * whose output is later labelled as ours.
     */
    renderNotes([...courses, ...cluster].slice(0, SHOWN)),
  ].join('\n');
}
