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

  const messages: ChatMessage[] = [
    { role: 'system', content: PROFILE_DOC.body },
    {
      role: 'user',
      content:
        `The document as it stands [${current.length}/${PROFILE_CHAR_LIMIT} characters]:\n` +
        `${current || '(empty -- nothing known about this student yet)'}\n\n` +
        'Exchanges since it was last written, oldest first:\n' +
        `${fresh.map((entry) => entry.content).join('\n\n')}\n\n` +
        'Return the whole document, rewritten. Return it exactly as it stands if none of ' +
        'this is worth keeping.',
    },
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
  if (written === '' || written === capProfile(current)) return { changed: false };

  await profiles.save(options.agentId, written, now);
  return { changed: true };
}
