import type { LlmProvider } from '@contexto/llm';
import { CHATS_DOC } from '../prompts/documents.js';
import {
  CHATS_DOC_LIMIT,
  CHATS_DOC_NAME,
  capDocument,
  readDocument,
  writeDocument,
} from './documents.js';

import type { Vault } from './vault.js';

/**
 * What is kept from a student's conversations, once they are over.
 *
 * Replaces the conversation profile, and differs from it in the one way that
 * matters: the profile belonged to an agent, so a student with three agents had
 * to tell each of them separately that they read on a phone and cannot take
 * long answers. This page belongs to the student. Said once, known everywhere.
 *
 * Rewritten whole rather than appended to, because a bounded page is what
 * forces the decision about what to drop -- and a page that only grows ends up
 * describing somebody who was dreading a presentation last March.
 *
 * Runs in the background after a conversation has gone quiet, not during one.
 * A pass judging a conversation that is still happening judges half of it, and
 * the cost lands on a student waiting for a reply.
 */

export interface ChatsDocDeps {
  llm: Pick<LlmProvider, 'chat'>;
}

export interface ChatsDocOptions {
  vault: Vault;
  /** The exchanges since this last ran, oldest first. */
  exchanges: string[];
  userId: string;
  /**
   * What was known about them before this page existed.
   *
   * The migration, and there is no SQL in it. Every student already has
   * per-agent profiles; handing them to the first write means nobody loses what
   * was learned about them on the day this ships. Ignored once a page exists.
   */
  knownBefore?: string[];
}

/** What a pass says when a conversation taught it nothing worth keeping. */
const NOTHING = 'UNCHANGED';

export async function updateChatsDoc(
  { llm }: ChatsDocDeps,
  { vault, exchanges, userId, knownBefore }: ChatsDocOptions,
): Promise<{ changed: boolean }> {
  if (exchanges.length === 0) return { changed: false };

  const existing = await readDocument(vault, CHATS_DOC_NAME);
  const standing = existing?.body?.trim() || (knownBefore ?? []).join('\n\n').trim();

  const answer = await llm.chat(
    {
      messages: [
        { role: 'system', content: CHATS_DOC.body },
        {
          role: 'user',
          content: [
            standing === ''
              ? 'Nothing has been kept about this student yet.'
              : `The page as it stands:\n\n${standing}`,
            '',
            'What has been said since, oldest first:',
            '',
            /*
             * Not through renderNotes.
             *
             * These are the student's own words to their own agent. They are
             * the one input in this system that carries no warning, which is
             * the whole reason a note records who wrote it.
             */
            exchanges.join('\n\n'),
            '',
            `The page may be at most ${CHATS_DOC_LIMIT} characters.`,
          ].join('\n'),
        },
      ],
    },
    { userId },
  );

  const said = typeof answer.content === 'string' ? answer.content.trim() : '';
  if (said === '' || said.toUpperCase().startsWith(NOTHING)) return { changed: false };

  const body = capDocument(said, CHATS_DOC_LIMIT);
  if (body === '') return { changed: false };

  await writeDocument(vault, {
    name: CHATS_DOC_NAME,
    description: 'What this student has told you, across every conversation',
    body,
  });

  return { changed: true };
}
