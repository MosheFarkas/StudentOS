import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from './vault.js';

/**
 * ContextoVault on disk.
 *
 * Files are the truth here rather than a projection of rows, which buys the
 * property the whole idea rests on -- a student could one day be handed the
 * folder and open it in Obsidian -- and costs the care that comes with running
 * a filesystem as a database.
 */

describe('Vault', () => {
  let root: string;
  let vault: Vault;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contexto-vault-'));
    vault = new Vault(root, 'agent-1');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const note = (over: Partial<Parameters<Vault['write']>[0]> = {}) => ({
    name: 'chemistry',
    kind: 'entity' as const,
    source: 'classroom' as const,
    description: 'Course',
    body: 'Chemistry, with [[mr-ali]].',
    ...over,
  });

  it('round-trips every field', async () => {
    await vault.write(note({ externalId: 'course-123' }));
    const read = await vault.read('entity', 'chemistry');

    expect(read).toEqual({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      externalId: 'course-123',
      body: 'Chemistry, with [[mr-ali]].',
    });
  });

  it('round-trips everything that makes an episode an episode', async () => {
    /*
     * The fields a later reader cannot recover if they are not stored. The
     * first version of this kept the time only in the filename and the sender
     * only in a prose description, so nothing could sort by when, filter by
     * who, or tell an assignment being posted from a grade coming back.
     */
    await vault.write({
      name: '2026-06-11-castle-portfolio-posted',
      kind: 'episode',
      source: 'gmail',
      description: 'Mrs Irwin posted a new portfolio assignment.',
      externalId: '19eb7811c9181665',
      occurred: '2026-06-11T14:32:00Z',
      actor: 'Mrs Irwin',
      event: 'assignment-posted',
      sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/19eb7811c9181665',
      body: 'Mrs Irwin posted a new portfolio assignment in Enriched English 10.',
    });

    const read = await vault.read('episode', '2026-06-11-castle-portfolio-posted');
    expect(read?.occurred).toBe('2026-06-11T14:32:00Z');
    expect(read?.actor).toBe('Mrs Irwin');
    expect(read?.event).toBe('assignment-posted');
    expect(read?.sourceUrl).toContain('mail.google.com');
  });

  it('leaves an entity free of the fields only an episode has', async () => {
    await vault.write(note());
    const read = await vault.read('entity', 'chemistry');
    expect(read?.occurred).toBeUndefined();
    expect(read?.event).toBeUndefined();
  });

  it('writes something a person can read', async () => {
    // The point of files. If this is not legible in a text editor, the vault
    // may as well have been a table.
    await vault.write(note());
    const raw = readFileSync(join(root, 'agent-1', 'entities', 'chemistry.md'), 'utf8');

    expect(raw).toContain('---');
    expect(raw).toContain('name: chemistry');
    expect(raw).toContain('Chemistry, with [[mr-ali]].');
  });

  it('separates entities from episodes on disk', async () => {
    await vault.write(note());
    await vault.write(note({ name: '2026-08-23-mock', kind: 'episode', body: 'Panicked.' }));

    expect((await vault.list('entity')).map((n) => n.name)).toEqual(['chemistry']);
    expect((await vault.list('episode')).map((n) => n.name)).toEqual(['2026-08-23-mock']);
  });

  it('knows whether this agent has a vault at all', async () => {
    /*
     * Whether to hand the agent a vault, and therefore whether to load the
     * reading rules onto its prompt, depends on there being something to read.
     * A student who has connected nothing should carry neither.
     */
    expect(await new Vault(root, 'never-imported').has()).toBe(false);
    await vault.write(note());
    expect(await vault.has()).toBe(true);
  });

  it('finds what points at a note, which is how a timeline is built', async () => {
    /*
     * An entity's history is not stored on it -- it is every episode that
     * links to it. That is the whole shape of the graph: an assignment knows
     * nothing about itself, and everything that ever happened to it knows the
     * assignment's name.
     */
    await vault.write(note({ name: 'cold-war-essay', body: 'Cold War essay.' }));
    await vault.write(
      note({
        name: '2026-09-02-moved',
        kind: 'episode',
        source: 'gmail',
        body: 'Mrs Bell moved it.\n\nAbout [[cold-war-essay]]\nIn [[history]]',
      }),
    );
    await vault.write(
      note({ name: 'unrelated', kind: 'episode', source: 'gmail', body: 'Nothing to do with it.' }),
    );

    const pointing = await vault.backlinks('cold-war-essay');
    expect(pointing.map((n) => n.name)).toEqual(['2026-09-02-moved']);
  });

  it('returns nothing for a note nothing points at', async () => {
    await vault.write(note());
    expect(await vault.backlinks('chemistry')).toEqual([]);
  });

  it('does not mistake a longer name for the one asked about', async () => {
    // [[chemistry-mock]] is not a link to [[chemistry]], and a substring match
    // would put every mock on the course's timeline.
    await vault.write(note({ name: 'chemistry-mock', kind: 'episode', body: 'x' }));
    await vault.write(
      note({ name: 'ep', kind: 'episode', source: 'gmail', body: 'About [[chemistry-mock]]' }),
    );
    expect(await vault.backlinks('chemistry')).toEqual([]);
  });

  it('returns null for a note that is not there', async () => {
    expect(await vault.read('entity', 'nonexistent')).toBeNull();
  });

  it('lists nothing for an agent with no vault yet', async () => {
    // The common case on the first run. A missing directory is not an error.
    expect(await new Vault(root, 'never-seen').list('entity')).toEqual([]);
  });

  it('overwrites a note in place rather than accumulating copies', async () => {
    await vault.write(note({ body: 'First.' }));
    await vault.write(note({ body: 'Second.' }));

    expect(await vault.list('entity')).toHaveLength(1);
    expect((await vault.read('entity', 'chemistry'))?.body).toBe('Second.');
  });

  it("keeps one agent out of another agent's vault", async () => {
    await vault.write(note());
    expect(await new Vault(root, 'agent-2').list('entity')).toEqual([]);
  });

  it('refuses a name that would escape the vault', async () => {
    /*
     * Belt and braces. slugForNote already makes this impossible, so reaching
     * here means a caller skipped it or somebody loosened the slug rules --
     * which is exactly when a second check earns its place.
     */
    for (const escape of ['../outside', 'a/b', '..', '/etc/passwd']) {
      await expect(vault.write(note({ name: escape }))).rejects.toThrow(/name/i);
    }
  });

  it('ignores a file that is not a note', async () => {
    // Obsidian leaves .obsidian directories about, and a student handed the
    // folder may put anything in it.
    mkdirSync(join(root, 'agent-1', 'entities'), { recursive: true });
    writeFileSync(join(root, 'agent-1', 'entities', 'notes.txt'), 'not a note');
    writeFileSync(join(root, 'agent-1', 'entities', 'broken.md'), 'no frontmatter here');

    await vault.write(note());
    expect((await vault.list('entity')).map((n) => n.name)).toEqual(['chemistry']);
  });
});
