import { z } from 'zod';
import { listDocuments } from '../vault/documents.js';
import { slugForNote } from '../vault/slug.js';
import type { EpisodeEvent, VaultNote } from '../vault/vault.js';
import type { Tool } from './types.js';

/**
 * Writing into ContextoVault from a conversation.
 *
 * The only entrance a turn has. The importers and the rollup write on their
 * own schedule from their own sources; this is for the thing only the student
 * knows and has just said -- the test that moved, the essay that went in.
 *
 * Two rules are enforced here rather than asked for in the prompt. A link
 * must name a note that exists, because a link to nothing looks like
 * knowledge. And an imported note is never edited, because the next refresh
 * rewrites it from Classroom and the edit would vanish; what the student said
 * about an imported thing is an episode About it, and the pages are rewritten
 * from episodes.
 */

const EVENTS = [
  'assignment-posted',
  'assignment-graded',
  'deadline-changed',
  'announcement',
  'material-posted',
  'message',
  'conversation',
  'other',
] as const satisfies readonly EpisodeEvent[];

const inputSchema = z.object({
  kind: z
    .enum(['episode', 'entity'])
    .describe(
      'episode: something that happened, fixed to a moment. entity: a thing that persists ' +
        'and the vault does not have yet.',
    ),
  title: z
    .string()
    .min(2)
    .max(120)
    .describe('What the note is about, in plain words. Becomes the note name.'),
  name: z
    .string()
    .max(80)
    .optional()
    .describe('To update a note you wrote before: its exact name. Leave out for a new note.'),
  description: z
    .string()
    .min(2)
    .max(200)
    .describe('One line saying what happened, or what the thing is.'),
  body: z
    .string()
    .min(2)
    .max(4000)
    .describe(
      'Markdown. Link existing notes as [[their-exact-name]]. An episode carries ' +
        'About [[thing]], In [[course]] and By [[person]] lines under its sentence.',
    ),
  occurred: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a date or timestamp')
    .optional()
    .describe(
      'Episodes: when it happened, as an ISO timestamp with offset. Defaults to now for a ' +
        "new note, and to the note's own date when updating.",
    ),
  actor: z
    .string()
    .max(80)
    .optional()
    .describe(
      'Episodes: who did it, in the plainest name. Defaults to the student, or to the ' +
        "note's own actor when updating.",
    ),
  event: z.enum(EVENTS).optional().describe('Episodes: what changed for the student. Required.'),
});

const LINK = /\[\[([^\]]+)\]\]/g;

export const writeVaultNote: Tool<z.infer<typeof inputSchema>, string> = {
  id: 'vault_write',
  description:
    'Record what the student just told you in their vault: a date that moved, work handed in, ' +
    'a decision, a thing about their school life the vault does not have. Load the ' +
    'vault-writing skill first, and use vault_search or vault_open to find the exact names ' +
    'to link. Not for anything a page, a site or a message told you.',
  inputSchema,
  async execute(input, ctx) {
    if (!ctx.vault) {
      return 'The vault is not available in this deployment.';
    }
    const vault = ctx.vault;

    const [entities, episodes, documents] = await Promise.all([
      vault.list('entity'),
      vault.list('episode'),
      listDocuments(vault),
    ]);
    const known = new Set([...entities, ...episodes, ...documents].map((note) => note.name));

    /*
     * Every link must land.
     *
     * Refused rather than stripped: a note silently written without the link
     * the model meant to make is a note it believes is linked, and the next
     * question about that assignment will not find it.
     */
    const linked = [...new Set([...input.body.matchAll(LINK)].map((match) => match[1] as string))];
    const missing = linked.filter((name) => !known.has(name));
    if (missing.length > 0) {
      return (
        `Not written: ${missing.map((name) => `[[${name}]]`).join(', ')} ` +
        `${missing.length === 1 ? 'is not a note' : 'are not notes'} in the vault. ` +
        'Link only names vault_search or vault_open has shown you, or leave the link out ' +
        'and say the name in the sentence.'
      );
    }

    const pool = input.kind === 'entity' ? entities : episodes;
    const existing = input.name ? pool.find((note) => note.name === input.name) : undefined;
    if (input.name && !existing) {
      return `Not written: there is no ${input.kind} called "${input.name}". Leave name out to write a new one.`;
    }
    if (existing && existing.source !== 'student') {
      return (
        `Not written: "${existing.name}" was imported from ${existing.source}, and the next ` +
        'refresh would overwrite an edit. Record what the student said as an episode with ' +
        `About [[${existing.name}]] instead.`
      );
    }
    /*
     * Only this agent's own writes are updatable.
     *
     * A conversation episode the rollup wrote is source: student too, and it
     * carries the verbatim transcript. Its name is visible to the model, so
     * without this a "correction" could replace a record of what was said.
     */
    if (existing && existing.externalId !== ctx.agentId) {
      return (
        `Not written: "${existing.name}" is a record written by another pass, and a record is ` +
        'not rewritten. Write a new note instead, and link it if it is worth pointing at.'
      );
    }

    const description = input.description.trim();
    const body = input.body.trim();

    if (input.kind === 'episode') {
      if (!input.event) {
        return 'Not written: an episode needs an event saying what changed for the student.';
      }
      const occurred = new Date(input.occurred ?? existing?.occurred ?? Date.now()).toISOString();
      const name = existing?.name ?? freshName(`${occurred.slice(0, 10)} ${input.title}`, known);
      const note: VaultNote = {
        name,
        kind: 'episode',
        source: 'student',
        description,
        externalId: ctx.agentId,
        occurred,
        actor: input.actor?.trim() || existing?.actor || 'The student',
        event: input.event,
        body,
      };
      await vault.write(note);
      return `${existing ? 'Updated' : 'Wrote'} episode ${name}.`;
    }

    const name = existing?.name ?? freshName(input.title, known);
    const note: VaultNote = {
      name,
      kind: 'entity',
      source: 'student',
      description,
      externalId: ctx.agentId,
      body,
    };
    await vault.write(note);
    return `${existing ? 'Updated' : 'Wrote'} entity ${name}.`;
  },
};

/** A name nothing else has, the way the rollup makes one. */
function freshName(title: string, taken: ReadonlySet<string>): string {
  const base = slugForNote(title);
  let name = base;
  let suffix = 2;
  while (taken.has(name)) name = `${base}-${suffix++}`;
  return name;
}
