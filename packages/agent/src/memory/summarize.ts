import type { ChatMessage, LlmProvider } from '@contexto/llm';
import { PROFILE_DOC } from '../prompts/documents.js';
import { PROFILE_CHAR_LIMIT, capProfile, type ProfileStore } from './profile.js';
import type { MemoryStore } from './types.js';

/**
 * Deciding what is worth keeping about a student.
 *
 * This runs between conversations, never during one. The profile it writes is
 * pinned in the cached part of the system prompt, so rewriting it mid-turn
 * would invalidate that prefix for the rest of the conversation -- Hermes
 * calls the alternative a frozen snapshot, and the same property falls out of
 * doing the work in a background job.
 *
 * What it replaces: the agent had no durable memory of a person at all. The
 * last eight exchanges rode along on every turn and everything older was
 * reachable only if the agent thought to search for it, which for a stated
 * preference it never does -- there is no question to ask. "I revise by
 * rewriting my notes", said once, was simply gone.
 */

/** How many recent exchanges the writer will look at in one pass. */
const MAX_EXCHANGES_PER_PASS = 40;

export interface ProfileWriterDeps {
  llm: Pick<LlmProvider, 'chat'>;
  memory: MemoryStore;
  profiles: ProfileStore;
}

export interface ProfileWriterOptions {
  agentId: string;
  /** The agent's owner. Inference is billed to them, not to a shared key. */
  userId: string;
  now?: Date;
}

/**
 * Rewrite one agent's profile from the exchanges since it was last written.
 *
 * Returns without spending anything when nothing has happened since, which is
 * the common case by a wide margin: a job on a timer that pays for a model
 * call every time it wakes has a bill that scales with uptime rather than with
 * use.
 */
export async function updateStudentProfile(
  { llm, memory, profiles }: ProfileWriterDeps,
  options: ProfileWriterOptions,
): Promise<{ changed: boolean }> {
  const now = options.now ?? new Date();
  const existing = await profiles.read(options.agentId);
  const current = existing?.profile ?? '';
  const since = existing?.updatedAt ?? null;

  const { recent } = await memory.recall(options.agentId, { limit: MAX_EXCHANGES_PER_PASS });
  const fresh = since ? recent.filter((entry) => entry.occurredAt > since) : recent;

  if (fresh.length === 0) return { changed: false };

  const exchanges = fresh.map((entry) => entry.content).join('\n\n');

  /*
   * Two different asks, because "return it unchanged" is nonsense with nothing
   * to return.
   *
   * The first version showed a placeholder -- "(empty, nothing known yet)" --
   * in the slot where the document goes, and asked for it back untouched if
   * nothing was worth keeping. Production's first run did exactly that, and
   * the placeholder was saved as what the agent knows about a person. The
   * model was following instructions: from where it sat, the placeholder WAS
   * the document. So there is no placeholder to hand back now.
   */
  const ask = current
    ? `The document as it stands [${current.length}/${PROFILE_CHAR_LIMIT} characters]:\n` +
      `${current}\n\n` +
      `Exchanges since it was last written, oldest first:\n${exchanges}\n\n` +
      'Return the whole document, rewritten. Return it exactly as it stands if none of ' +
      'this is worth keeping.'
    : 'There is no document for this student yet.\n\n' +
      `Their exchanges so far, oldest first:\n${exchanges}\n\n` +
      `Write the first version, up to ${PROFILE_CHAR_LIMIT} characters. Reply with an ` +
      'empty message if none of this is worth keeping, which is the usual answer.';

  const messages: ChatMessage[] = [
    { role: 'system', content: PROFILE_DOC.body },
    { role: 'user', content: ask },
  ];

  const response = await llm.chat({ messages }, { userId: options.userId });
  const written = capProfile(typeof response.content === 'string' ? response.content : '');

  /*
   * An empty completion must not wipe what the agent already knew.
   *
   * A refusal, a safety filter, or a truncated response all arrive as an empty
   * string, and treating that as "the student is now a blank" would silently
   * destroy months of accumulated memory with nothing to notice it.
   */
  /*
   * A model narrating emptiness is not a profile.
   *
   * Belt and braces alongside removing the placeholder: models describe an
   * absence in a dozen ways, and any of them saved here becomes a permanent
   * line in a prompt that every turn pays for.
   */
  const describesNothing = /^\(?\s*(?:empty|none|nothing|no (?:profile|document|information))\b/i;

  const keep = written === '' || written === capProfile(current) || describesNothing.test(written);

  /*
   * Write back either way, because the timestamp is a watermark.
   *
   * It records when this agent's memory was last CONSIDERED, not when the
   * document last changed. Leaving it alone on a pass that decided nothing was
   * worth keeping leaves the agent permanently stale, and the job re-reads the
   * same exchanges to reach the same conclusion on every wake. Production had
   * two agents in exactly that state within an hour of this shipping.
   */
  await profiles.save(options.agentId, keep ? capProfile(current) : written, now);
  return { changed: !keep };
}
