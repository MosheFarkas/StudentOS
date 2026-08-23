import { z } from 'zod';
import type { ChatMessage, LlmProvider } from '@contexto/llm';
import { VAULT_WRITING } from '../prompts/documents.js';
import { untrustedNote } from '../untrusted.js';
import { slugForNote } from './slug.js';
import type { EpisodeEvent, Vault } from './vault.js';

/**
 * Turning school mail into ContextoVault episodes.
 *
 * The only part of the bootstrap that needs a model. Classroom arrives as
 * objects with ids; mail arrives as prose somebody else wrote, and deciding
 * what a message means is judgement rather than mapping.
 *
 * What an episode is, and when one is worth making, is defined once in
 * prompts/vault-writing.md rather than restated here. That document is the
 * system prompt for this pass and for every other pass that writes into the
 * vault, so the rules cannot drift between them.
 *
 * The containment is structural rather than a matter of asking nicely:
 *
 *   The pass runs with no tools. A hijacked model has nothing to call, so the
 *   worst outcome available to a hostile message is a wrong sentence in a
 *   note -- visible in the memory panel and deletable by the student.
 *
 *   Its answer is parsed against a schema. Free text is confined to one
 *   summary field with a length cap, so instructions cannot ride out through a
 *   shape that was meant to carry a name.
 *
 *   Links may only point at notes that already exist. It cannot invent a
 *   target, so an edge always lands somewhere real.
 */

export interface SchoolMessage {
  messageId: string;
  from: string;
  subject: string;
  date: string;
  body: string;
}

export interface MailImportDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface MailImportOptions {
  vault: Vault;
  messages: SchoolMessage[];
  /** Note names an episode may link to. Nothing else is accepted. */
  entities: string[];
  userId: string;
  /** The school's domain. A sender outside it is not one of their teachers. */
  domain?: string;
}

export interface MailImportResult {
  written: number;
  skipped: number;
  people: number;
}

const EVENTS = [
  'assignment-posted',
  'assignment-graded',
  'deadline-changed',
  'announcement',
  'material-posted',
  'message',
  'conversation',
  'other',
] as const;

const extraction = z.object({
  keep: z.boolean(),
  what: z.string().max(400),
  /** Who did it, as a student would say it. Empty when it was a system. */
  actor: z.string().max(80).default(''),
  event: z.enum(EVENTS).default('other'),
  /** The specific thing: an assignment, a topic. */
  about: z.array(z.string()).max(5).default([]),
  /** The course it belongs to. */
  inCourse: z.array(z.string()).max(3).default([]),
});

const ASK = [
  'You are reading one email from a school inbox and writing a single episode for',
  'ContextoVault, following the rules above.',
  '',
  untrustedNote('The message below was written by whoever sent it, not by the student.'),
  '',
  'Reply with JSON only, no prose around it:',
  '{"keep": boolean, "what": string, "actor": string, "event": string,',
  ' "about": string[], "inCourse": string[]}',
  '',
  `event is one of: ${EVENTS.join(', ')}.`,
  '',
  'about and inCourse may only contain names from the list you are given. Omit rather',
  'than guess. keep is false for newsletters, receipts and automated notices that change',
  'nothing -- which is most mail.',
].join('\n');

/**
 * Senders that are software rather than people.
 *
 * A note for no-reply@classroom.google.com would become one of the most-linked
 * nodes in the vault, and it is not somebody the student knows.
 */
const AUTOMATED =
  /(^|[.@])(no-?reply|noreply|do-?not-?reply|notifications?|mailer|bounce)([.@]|$)/i;

/** `"Mrs. Bell" <bell.j@school.example>` into its two halves. */
function parseSender(from: string): { display: string; address: string } {
  const angled = /<([^>]+)>/.exec(from);
  const address = (angled?.[1] ?? from).trim().toLowerCase();
  const display = from
    .replace(/<[^>]*>/, '')
    .replace(/["']/g, '')
    .trim();
  return { display: display || address, address };
}

export async function importMail(
  { llm }: MailImportDeps,
  { vault, messages, entities, userId, domain }: MailImportOptions,
): Promise<MailImportResult> {
  const existingEpisodes = await vault.list('episode');
  const already = new Set(existingEpisodes.map((note) => note.externalId).filter(Boolean));
  const takenNames = new Set(existingEpisodes.map((note) => note.name));

  const allowed = new Set(entities);

  /*
   * People are resolved by address, never by name.
   *
   * The first real run produced lucas-liu and lucas-yunqi-liu: one person,
   * twice, because the note was named after the model's rendering of the name
   * and that varies between messages. An address does not vary. This is the
   * entity resolution failure the design exists to avoid, and it appeared the
   * moment real mail arrived -- exactly as the literature says it does.
   */
  const peopleByAddress = new Map(
    (await vault.list('entity'))
      .filter((note) => note.description === 'Person' && note.externalId)
      .map((note) => [note.externalId as string, note.name]),
  );

  const result: MailImportResult = { written: 0, skipped: 0, people: 0 };

  /*
   * Episode names have to be unique and their ingredients are not.
   *
   * The name is the day plus the subject, and Classroom notifications reuse
   * both. Found on a real inbox as twenty written and eighteen on disk.
   */
  const uniqueName = (base: string): string => {
    let name = base;
    let suffix = 2;
    while (takenNames.has(name)) name = `${base}-${suffix++}`;
    takenNames.add(name);
    return name;
  };

  for (const message of messages) {
    // Gmail ids are stable, so a second run is a lookup -- checked before the
    // model call, because the point is not to pay twice for the same message.
    if (already.has(message.messageId)) continue;

    const sender = parseSender(message.from);
    const shortlist = shortlistFor(message, entities);

    const chat: ChatMessage[] = [
      { role: 'system', content: `${VAULT_WRITING.body}\n\n---\n\n${ASK}` },
      {
        role: 'user',
        content:
          `Names you may link to:\n${shortlist.join('\n') || '(none)'}\n\n` +
          `From: ${message.from}\nSubject: ${message.subject}\nDate: ${message.date}\n\n` +
          message.body.slice(0, 6000),
      },
    ];

    // No tools. Not an omission -- the containment argument rests on it.
    const response = await llm.chat({ messages: chat }, { userId });

    const parsed = parseExtraction(response.content);
    if (!parsed) {
      result.skipped += 1;
      continue;
    }
    if (!parsed.keep || parsed.what.trim() === '') continue;

    /*
     * A note for the person who sent it.
     *
     * "Who sent what" needs somebody to have been sent from, and Classroom
     * does not hand over teachers -- listCourses returns an id and a name and
     * nothing else. Senders at the school's own domain are the only place
     * people come from, and they are the most-linked nodes the vault lacked.
     */
    let personNote: string | undefined;
    const atSchool = domain ? sender.address.endsWith(`@${domain}`) : false;
    if (atSchool && !AUTOMATED.test(sender.address) && parsed.actor.trim() !== '') {
      // The address decides identity. Whatever this message called them, a
      // person already seen keeps the note and the name they were given first.
      personNote = peopleByAddress.get(sender.address);

      if (!personNote) {
        personNote = slugForNote(parsed.actor);
        await vault.write({
          name: personNote,
          kind: 'entity',
          source: 'gmail',
          description: 'Person',
          externalId: sender.address,
          body: `${parsed.actor.trim()}, at ${sender.address}.`,
        });
        peopleByAddress.set(sender.address, personNote);
        result.people += 1;
      }
      allowed.add(personNote);
    }

    const about = parsed.about.filter((name) => allowed.has(name));
    const inCourse = parsed.inCourse.filter((name) => allowed.has(name));
    const occurred = isoTime(message.date);

    await vault.write({
      name: uniqueName(slugForNote(`${occurred.slice(0, 10)} ${message.subject}`)),
      kind: 'episode',
      source: 'gmail',
      description: parsed.what.trim().slice(0, 200),
      externalId: message.messageId,
      occurred,
      ...(parsed.actor.trim() ? { actor: parsed.actor.trim() } : {}),
      event: parsed.event as EpisodeEvent,
      sourceUrl: `https://mail.google.com/mail/u/0/#all/${message.messageId}`,
      body: [
        parsed.what.trim(),
        '',
        ...about.map((name) => `About [[${name}]]`),
        ...inCourse.map((name) => `In [[${name}]]`),
        ...(personNote ? [`By [[${personNote}]]`] : []),
        '',
        '## The message',
        '',
        `From: ${message.from}`,
        `Subject: ${message.subject}`,
        '',
        message.body.trim(),
      ]
        .join('\n')
        .trim(),
    });
    result.written += 1;
  }

  return result;
}

/**
 * Which entities to offer this message.
 *
 * A whole vault is hundreds of names and most of a prompt. Narrowing on shared
 * words keeps the list short and keeps the model choosing rather than scanning.
 */
function shortlistFor(message: SchoolMessage, entities: string[]): string[] {
  const words = new Set(
    `${message.subject} ${message.body.slice(0, 800)}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  );

  return entities
    .map((name) => ({ name, score: name.split('-').filter((part) => words.has(part)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map(({ name }) => name);
}

/** The model's answer, or nothing. A refusal and a truncation look the same. */
function parseExtraction(content: unknown): z.infer<typeof extraction> | null {
  if (typeof content !== 'string') return null;

  const text = content.trim().replace(/^```(?:json)?\s*/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = extraction.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** When it happened, not when it was read. Falls back to something sortable. */
function isoTime(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? '0000-01-01T00:00:00.000Z' : parsed.toISOString();
}
