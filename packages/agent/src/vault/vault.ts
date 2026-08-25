import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

/**
 * ContextoVault: one student's knowledge, as files on disk.
 *
 * Files rather than rows, deliberately. It costs the care that comes with
 * running a filesystem as a database, and it buys the property the whole idea
 * rests on: the vault is something a student could be handed. A folder of
 * markdown with wikilinks opens in Obsidian, survives this product, and is
 * legible to a person who wants to know what a machine believes about them.
 *
 * Notes are of two kinds. Entities are the things that persist -- a course, an
 * assignment, a teacher, a preference -- and are rewritten as they change.
 * Episodes are what happened, at a point in time, and are never rewritten.
 *
 * `source` records who wrote the underlying material. It is not decoration: a
 * note derived from a teacher's email carries text this product did not author,
 * and how it is rendered into a prompt depends on knowing that. Nothing reads
 * notes into a prompt yet, which is why the importer can be built before the
 * trust boundary rather than after it.
 */

export type NoteKind = 'entity' | 'episode';

/** Who wrote the material a note is derived from. */
export type NoteSource = 'student' | 'classroom' | 'drive' | 'gmail' | 'portal' | 'agent';

/**
 * What kind of thing happened.
 *
 * A closed list, because the value of the field is that it can be counted and
 * filtered. "A grade came back" and "an assignment was posted" are different
 * events even when both arrive as email, and a free-text field would record
 * them a dozen different ways.
 */
export type EpisodeEvent =
  | 'assignment-posted'
  | 'assignment-graded'
  | 'deadline-changed'
  | 'announcement'
  | 'material-posted'
  | 'message'
  | 'conversation'
  | 'other';

export interface VaultNote {
  /** Slug. Also the filename. Produced by slugForNote, never raw. */
  name: string;
  kind: NoteKind;
  source: NoteSource;
  /** One line, for a reader and for a future loader deciding relevance. */
  description: string;
  /**
   * Episodes only: when the thing happened, not when it was imported.
   *
   * The field that makes an episode an episode. Keeping it only in the
   * filename, as the first version did, means nothing can sort or filter by
   * it -- which is most of what a timeline is for.
   */
  occurred?: string;
  /** Episodes only: who did it, in the plainest name a student would use. */
  actor?: string;
  /** Episodes only: what changed for the student. */
  event?: EpisodeEvent;
  /** Where this came from, so a person can go and look. */
  sourceUrl?: string;
  /**
   * Stable id in the system this came from -- a Classroom courseId, a Gmail
   * messageId. What makes re-syncing an exact lookup rather than a guess.
   */
  externalId?: string;
  /** Markdown, with [[wikilinks]] to other notes. */
  body: string;
}

const DIRECTORY: Record<NoteKind, string> = {
  entity: 'entities',
  episode: 'episodes',
};

/** A name that is safe to join onto a path: the slug alphabet, nothing else. */
const SAFE_NAME = /^[a-z0-9-]+$/;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export class Vault {
  readonly #dir: string;

  /**
   * Where this vault lives.
   *
   * Exposed for the one thing that belongs beside a vault without being a note
   * in it: the document describing the student, which has no links and should
   * not appear in a picture of what their school looks like.
   */
  get directory(): string {
    return this.#dir;
  }

  /**
   * @param ownerId The student the vault belongs to, never an agent.
   *
   * It is built from their own Classroom and their own mail, so it is theirs
   * and every agent they make reads the same one. Keyed by agent it was a
   * second empty vault per agent, and an agent that knew nothing about their
   * school -- found on a real account with 1401 notes filed under an agent the
   * settings page was not showing.
   */
  constructor(root: string, ownerId: string) {
    /*
     * Better Auth issues nanoids and the database issues uuids, so both
     * alphabets have to pass -- nanoid's includes the underscore, which the
     * uuid-shaped rule this started as rejected outright.
     *
     * Everything else is refused, because this becomes a path segment and it
     * is the only thing between a malformed caller and another student's
     * notes. No dot, no slash, so no way to climb out.
     */
    if (!/^[A-Za-z0-9_-]+$/.test(ownerId)) throw new Error(`Unsafe owner id: ${ownerId}`);
    this.#dir = join(root, ownerId);
  }

  /**
   * Where a note lives, verified to be inside the vault.
   *
   * slugForNote already makes an escaping name impossible, so arriving here
   * with one means a caller skipped it or the slug rules were loosened. That is
   * exactly when a second check earns its place -- the cost of being wrong is a
   * write somewhere else on the machine.
   */
  #pathFor(kind: NoteKind, name: string): string {
    if (!SAFE_NAME.test(name)) {
      throw new Error(`Unsafe note name: ${JSON.stringify(name)}`);
    }

    const directory = join(this.#dir, DIRECTORY[kind]);
    const path = resolve(directory, `${name}.md`);
    if (!path.startsWith(resolve(directory) + sep)) {
      throw new Error(`Note name escapes the vault: ${JSON.stringify(name)}`);
    }
    return path;
  }

  /**
   * Write a note, atomically.
   *
   * Temp file then rename, because the alternative is a crashed import leaving
   * a half-written note that parses as a shorter, wrong one.
   */
  async write(note: VaultNote): Promise<void> {
    const path = this.#pathFor(note.kind, note.name);
    await mkdir(join(this.#dir, DIRECTORY[note.kind]), { recursive: true });

    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, serialise(note), 'utf8');
    await rename(temp, path);
  }

  /**
   * Whether this agent has a vault worth handing to a turn.
   *
   * Decides two things at once: whether the search tool has anything to search,
   * and whether the reading rules are loaded onto the prompt. A student who has
   * connected nothing should carry neither.
   */
  /**
   * Take a note out of the vault.
   *
   * Needed because an import can create notes that should never have existed:
   * Classroom's "[Template]" masters are files no student can open, and they
   * sat in a real vault as unreadable notes whose links opened nothing.
   *
   * @returns whether there was anything there to remove.
   */
  async remove(kind: NoteKind, name: string): Promise<boolean> {
    try {
      await rm(this.#pathFor(kind, name));
      return true;
    } catch {
      // Already gone is the outcome the caller wanted either way.
      return false;
    }
  }

  async has(): Promise<boolean> {
    return (await this.list('entity')).length > 0;
  }

  /**
   * Every note pointing at this one, newest first.
   *
   * An entity's history is not stored on the entity. It is every episode that
   * links to it, which is the whole shape of the graph: an assignment knows
   * nothing about itself, and everything that ever happened to it knows the
   * assignment's name. So a timeline is a backlink query.
   */
  async backlinks(name: string): Promise<VaultNote[]> {
    // Exact, inside the brackets. A substring match would put every
    // [[chemistry-mock]] on the [[chemistry]] timeline.
    const link = `[[${name}]]`;
    const [entities, episodes] = await Promise.all([this.list('entity'), this.list('episode')]);

    return [...entities, ...episodes]
      .filter((note) => note.name !== name && note.body.includes(link))
      .sort((a, b) => (b.occurred ?? '').localeCompare(a.occurred ?? ''));
  }

  async read(kind: NoteKind, name: string): Promise<VaultNote | null> {
    try {
      return parse(await readFile(this.#pathFor(kind, name), 'utf8'), kind);
    } catch {
      return null;
    }
  }

  /**
   * Every note of a kind.
   *
   * Anything that does not parse as a note is skipped rather than thrown on: a
   * vault is a folder, a folder handed to a student will eventually contain
   * whatever they put in it, and Obsidian leaves its own files about.
   */
  /**
   * How many notes of a kind there are, without opening any of them.
   *
   * The settings page polls this every few seconds while a vault is building,
   * and a build runs for hours. list() reads and parses every note, so polling
   * it on a three thousand note vault meant millions of file reads competing
   * with the build they were reporting on.
   */
  async count(kind: NoteKind): Promise<number> {
    try {
      const files = await readdir(join(this.#dir, DIRECTORY[kind]));
      return files.filter((file) => file.endsWith('.md')).length;
    } catch {
      // No vault yet is nought notes, not an error.
      return 0;
    }
  }

  async list(kind: NoteKind): Promise<VaultNote[]> {
    const directory = join(this.#dir, DIRECTORY[kind]);

    let files: string[];
    try {
      files = await readdir(directory);
    } catch {
      return [];
    }

    const notes: VaultNote[] = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const parsed = parse(await readFile(join(directory, file), 'utf8').catch(() => ''), kind);
      if (parsed) notes.push(parsed);
    }
    return notes.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function serialise(note: VaultNote): string {
  const lines = [
    '---',
    `name: ${note.name}`,
    `kind: ${note.kind}`,
    `source: ${note.source}`,
    `description: ${note.description}`,
    ...(note.externalId ? [`externalId: ${note.externalId}`] : []),
    ...(note.occurred ? [`occurred: ${note.occurred}`] : []),
    ...(note.actor ? [`actor: ${note.actor}`] : []),
    ...(note.event ? [`event: ${note.event}`] : []),
    ...(note.sourceUrl ? [`sourceUrl: ${note.sourceUrl}`] : []),
    '---',
    '',
    note.body.trim(),
    '',
  ];
  return lines.join('\n');
}

function parse(raw: string, kind: NoteKind): VaultNote | null {
  const frontmatter = FRONTMATTER.exec(raw);
  if (!frontmatter?.[1]) return null;

  const fields = new Map<string, string>();
  for (const line of frontmatter[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const name = fields.get('name');
  const source = fields.get('source');
  if (!name || !source) return null;

  /** Omit an absent field rather than carrying an undefined through. */
  const optional = (key: string): Record<string, string> => {
    const value = fields.get(key);
    return value ? { [key]: value } : {};
  };

  return {
    name,
    kind,
    source: source as NoteSource,
    description: fields.get('description') ?? '',
    ...optional('externalId'),
    ...optional('occurred'),
    ...optional('actor'),
    ...(optional('event') as { event?: EpisodeEvent }),
    ...optional('sourceUrl'),
    body: raw.slice(frontmatter[0].length).trim(),
  };
}
