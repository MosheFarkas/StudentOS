import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { LlmProvider } from '@contexto/llm';
import { untrustedNote } from '../untrusted.js';
import { courseForFolder } from './collapse.js';
import { courseTitles, type DriveFile, type DriveVerdict } from './drive.js';
import { retrying } from './retry.js';
import type { Vault } from './vault.js';

/**
 * Deciding about every file in a Drive, not only the ones in a course folder.
 *
 * A student who connects Drive has handed over the whole of it -- full read
 * access comes with the connection -- and a folder that names a course places
 * only a fraction of what is there. The rest used to be thrown away unread: a
 * CAS brainstorming document, an application, revision with no folder, along
 * with the photographs and the music the rule was written to keep out.
 *
 * So the rest is judged, on what the listing says about each file: its name,
 * what kind of thing it is, whose it is, where it sits, when it last changed.
 * Fifty at a time, against the student's courses and what is known about
 * their school, so "CAS" means something. Reading a file to decide about it
 * would be a model call per file for the whole Drive; the listing is enough
 * to tell a study guide from a holiday album, and what stays is read anyway
 * by the pass that writes its sentence.
 *
 * A verdict is kept. A file is asked about once, and again only when it has
 * changed -- otherwise a Drive of five hundred files is ten model calls on
 * every refresh for ever, to reach the same answers.
 */

export interface DriveTriageDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface DriveTriageOptions {
  vault: Vault;
  /** The whole listing. What needs no judging is passed over here. */
  files: DriveFile[];
  /** ISO date. A model has no clock. */
  today: string;
  /** ISO date this school year began. Nothing changed before the year before it is judged. */
  yearStart: string;
  /** The school page, where one has been written. It names the programmes a file may be for. */
  school?: string;
  userId: string;
}

/** How many files one question is about. */
const BATCH = 50;

/** Where the verdicts live: beside the notes, not among them. */
const LEDGER = 'drive-judged.json';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

type Ledger = Record<string, DriveVerdict & { modifiedAt: string }>;

const verdicts = z.object({
  files: z
    .array(
      z.object({
        file: z.coerce.number().int(),
        keep: z.boolean(),
        inCourse: z.string().nullish(),
      }),
    )
    .default([]),
});

const ASK = [
  'You are reading a list of files from one student’s Google Drive, and deciding which',
  'of them belong in the notes their study agent keeps about their schooling.',
  '',
  'Reply with JSON only, no prose around it:',
  '{"files": [{"file": number, "keep": boolean, "inCourse": string | null}]}',
  '',
  'file is the NUMBER the file is listed under, never its name. Answer for every number.',
  '',
  'keep is true for anything about their schooling: coursework, essays, revision and',
  'study guides, notes, projects, lab work, presentations, applications and personal',
  'statements, anything for a programme, a club, a team or a competition the school',
  'runs, and anything a teacher shared with them. It is false for the rest of a',
  'Drive: photographs, music, videos, games, downloads, receipts, personal writing.',
  'When a name could be either, keep it -- what stays is read properly later, and a',
  'study guide left out is gone for good.',
  '',
  'inCourse is the ONE entry on the list you are given that the file plainly belongs to,',
  'copied exactly, or null. The list is every room the student has on Classroom, and',
  'that includes clubs, teams, houses and programmes as well as subjects -- so a robotics',
  'team’s supply list belongs to the robotics room, and a business club’s pitch belongs',
  'to the club. Null when nothing on the list fits, which is common: a personal statement',
  'or a CAS plan is for a programme with no room of its own. A wrong match is worse than',
  'none. Never invent an entry, and never use a name that is not on the list.',
].join('\n');

/**
 * Which files stay, and under what, for everything a folder did not place.
 *
 * Returns a verdict for every listed file that has one -- remembered or fresh.
 * A file with no verdict is one nobody has judged yet, and the importer leaves
 * it for the next refresh rather than reading silence as an answer.
 */
export async function judgeDriveFiles(
  { llm }: DriveTriageDeps,
  { vault, files, today, yearStart, school, userId }: DriveTriageOptions,
): Promise<Map<string, DriveVerdict>> {
  const existing = await vault.list('entity');
  const known = new Set(existing.map((note) => note.externalId).filter(Boolean));
  const courses = courseTitles(existing);

  // Last year is as far back as anything is kept, files included.
  const lastYearBegan = `${Number(yearStart.slice(0, 4)) - 1}${yearStart.slice(4)}`;

  const ledger = await readLedger(vault);
  const judged = new Map<string, DriveVerdict>();
  const asking: DriveFile[] = [];

  for (const file of files) {
    if (file.mimeType === FOLDER || file.mimeType === SHORTCUT) continue;
    // Classroom knows more about this one, and its note is already written.
    if (known.has(file.fileId)) continue;
    // A folder that names a course has already decided.
    if ((file.path ?? []).some((folder) => courseForFolder(folder, courses))) continue;
    if (file.modifiedAt && file.modifiedAt.slice(0, 10) < lastYearBegan) continue;

    const remembered = ledger[file.fileId];
    if (remembered && remembered.modifiedAt === (file.modifiedAt ?? '')) {
      judged.set(file.fileId, { keep: remembered.keep, course: remembered.course });
      continue;
    }
    asking.push(file);
  }

  let changed = false;
  for (let at = 0; at < asking.length; at += BATCH) {
    const batch = asking.slice(at, at + BATCH);
    const said = await ask(llm, { batch, courses, today, school, userId });
    for (const [listedAs, verdict] of said) {
      const file = batch[listedAs - 1];
      if (!file) continue;
      judged.set(file.fileId, verdict);
      ledger[file.fileId] = { ...verdict, modifiedAt: file.modifiedAt ?? '' };
      changed = true;
    }
  }

  if (changed) await writeLedger(vault, ledger);
  return judged;
}

/** One batch, asked once. An answer that cannot be read is no answer. */
async function ask(
  llm: Pick<LlmProvider, 'chat'>,
  {
    batch,
    courses,
    today,
    school,
    userId,
  }: {
    batch: DriveFile[];
    courses: ReadonlyMap<string, string>;
    today: string;
    school: string | undefined;
    userId: string;
  },
): Promise<Map<number, DriveVerdict>> {
  const listed = [
    '<untrusted>',
    untrustedNote('The files below are named by whoever made them.'),
    '',
    batch.map((file, index) => describe(file, index + 1)).join('\n'),
    '</untrusted>',
  ].join('\n');

  const found = new Map<number, DriveVerdict>();
  try {
    const response = await retrying(() =>
      llm.chat(
        {
          messages: [
            { role: 'system', content: ASK },
            {
              role: 'user',
              content: [
                `Today is ${today}.`,
                '',
                'The courses the student takes:',
                ...[...courses.keys()].map((title) => `- ${defang(title)}`),
                ...(school
                  ? [
                      '',
                      'What is known about the school, which may name its programmes and clubs:',
                      '',
                      school,
                    ]
                  : []),
                '',
                'The files:',
                listed,
              ].join('\n'),
            },
          ],
        },
        { userId },
      ),
    );

    for (const said of parse(response.content)?.files ?? []) {
      // A course off the list is a guess, and a guess is worse than no subject.
      const course = said.inCourse ? (courses.get(said.inCourse) ?? null) : null;
      found.set(said.file, { keep: said.keep, course: said.keep ? course : null });
    }
  } catch {
    // Left unjudged, for the next refresh. See the note on silence above.
  }
  return found;
}

/** One file, as much as a listing knows about it. */
function describe(file: DriveFile, listedAs: number): string {
  const facts = [
    kindOf(file.mimeType),
    file.ownedByStudent ? 'theirs' : file.owner ? `shared by ${defang(file.owner)}` : 'shared',
    ...(file.path && file.path.length > 0 ? [`in ${defang(file.path.join('/'))}`] : []),
    ...(file.modifiedAt ? [`changed ${file.modifiedAt.slice(0, 10)}`] : []),
  ];
  return `${listedAs}. ${defang(file.name)} -- ${facts.join(', ')}`;
}

function kindOf(mimeType: string): string {
  if (mimeType === 'application/vnd.google-apps.document') return 'document';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'spreadsheet';
  if (mimeType === 'application/vnd.google-apps.presentation') return 'slides';
  if (mimeType === 'application/vnd.google-apps.form') return 'form';
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/')) return 'text file';
  return mimeType.split('/').pop() || 'file';
}

/** Angle brackets folded, so nothing a file is called can close the wrapper. */
function defang(text: string): string {
  return text.replaceAll('<', '‹').replaceAll('>', '›');
}

function parse(content: unknown): z.infer<typeof verdicts> | null {
  if (typeof content !== 'string') return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = verdicts.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readLedger(vault: Vault): Promise<Ledger> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(vault.directory, LEDGER), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Ledger) : {};
  } catch {
    // Missing, or unreadable: either way nothing is remembered.
    return {};
  }
}

async function writeLedger(vault: Vault, ledger: Ledger): Promise<void> {
  await mkdir(vault.directory, { recursive: true });
  await writeFile(join(vault.directory, LEDGER), JSON.stringify(ledger, null, 2));
}
