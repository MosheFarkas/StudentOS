import { z } from 'zod';
import { queryTerms, rankByTermMatches } from '../memory/search.js';
import { renderNotes } from '../vault/render.js';
import type { VaultNote } from '../vault/vault.js';
import type { Tool } from './types.js';

/**
 * Looking things up in ContextoVault.
 *
 * The only entrance. Everything returned has been through renderNotes, so the
 * warning that travels with imported notes cannot be walked around by adding a
 * second reader later -- there is no path that reads the vault without it.
 *
 * Matching reuses the ranking the memory search already uses, for the reason it
 * was written: an agent asks "cold war essay deadline" and a note says "Cold
 * War essay", and anything demanding the whole phrase finds nothing.
 */

const inputSchema = z.object({
  query: z
    .string()
    .min(2)
    .describe('Words to look for. A subject, an assignment, a teacher, a topic.'),
  limit: z.number().int().min(1).max(12).optional().describe('How many notes. Defaults to 6.'),
});

export const searchVault: Tool<z.infer<typeof inputSchema>, string> = {
  id: 'vault_search',
  /*
   * The description carries the trigger, not the capability.
   *
   * A model told "searches the vault" reaches for it when a student says
   * "search my vault", which no student says. It has to name the questions
   * only this can answer.
   */
  description:
    "Search everything known about this student's school: their courses, assignments, " +
    'topics, teachers, and a record of what happened and when. Use it when the answer ' +
    'needs more than one source at once or needs the past -- has a deadline moved, what ' +
    'did a teacher actually say, what came back on a piece of work, does this teacher ' +
    'always post late. For what is true right now, prefer the live Classroom and mail ' +
    'tools; this is a copy taken when it was last read.',
  inputSchema,
  async execute(input, ctx) {
    if (!ctx.vault) {
      return 'The vault is not available in this deployment.';
    }

    const terms = queryTerms(input.query);
    if (terms.length === 0) return `Nothing in the vault matches "${input.query}".`;

    const [entities, episodes] = await Promise.all([
      ctx.vault.list('entity'),
      ctx.vault.list('episode'),
    ]);

    /*
     * Name and body both count.
     *
     * A note's name is the most concentrated description of it there is -- an
     * assignment titled "Cold War essay" is named cold-war-essay -- so a match
     * there is worth more than a mention buried in a body.
     */
    const searchable = [...entities, ...episodes].map((note) => ({
      note,
      content: `${note.name.replaceAll('-', ' ')} ${note.description} ${note.body}`,
      // Episodes have a time; entities are ranked as though always current, so
      // recency only ever settles a tie between two episodes.
      occurredAt: new Date(note.occurred ?? 0),
    }));

    const hits = rankByTermMatches(searchable, terms)
      .slice(0, input.limit ?? 6)
      .map(({ note }) => note as VaultNote);

    if (hits.length === 0) return `Nothing in the vault matches "${input.query}".`;
    return renderNotes(hits);
  },
};
