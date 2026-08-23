import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
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
export type NoteSource = 'student' | 'classroom' | 'gmail' | 'portal' | 'agent';

export interface VaultNote {
  /** Slug. Also the filename. Produced by slugForNote, never raw. */
  name: string;
  kind: NoteKind;
  source: NoteSource;
  /** One line, for a reader and for a future loader deciding relevance. */
  description: string;
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

  constructor(root: string, agentId: string) {
    // Agent ids are database uuids. Anything else is a caller mistake, and a
    // caller mistake here is a directory somewhere it should not be.
    if (!/^[a-zA-Z0-9-]+$/.test(agentId)) throw new Error(`Unsafe agent id: ${agentId}`);
    this.#dir = join(root, agentId);
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

  const externalId = fields.get('externalId');
  return {
    name,
    kind,
    source: source as NoteSource,
    description: fields.get('description') ?? '',
    ...(externalId ? { externalId } : {}),
    body: raw.slice(frontmatter[0].length).trim(),
  };
}
