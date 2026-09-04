/**
 * The first message, carried from the new-chat screen into the conversation.
 *
 * Starting a chat is two steps -- create the agent, then say the thing -- and
 * the screen changes between them. Waiting for the whole turn before
 * navigating would leave the student on a blank screen watching nothing for
 * however long the agent takes, which on a question that opens their portal is
 * several seconds. So the chat is created, the message is left here, and the
 * conversation picks it up as it opens.
 *
 * Deliberately in memory rather than sessionStorage. A reload should lose it:
 * a message that survives a refresh and sends itself is a message the student
 * did not ask to send twice.
 */
interface Handoff {
  agentId: string;
  content: string;
  /** Vault notes uploaded with it, by name. */
  attachments: string[];
}

let waiting: Handoff | undefined;

export function handOff(agentId: string, content: string, attachments: string[] = []): void {
  waiting = { agentId, content, attachments };
}

/**
 * The message left for this chat, if there is one. Taken, not read: a second
 * caller gets nothing, so a re-run of the effect that consumes it cannot send
 * the same message twice.
 */
export function takeHandoff(
  agentId: string,
): { content: string; attachments: string[] } | undefined {
  if (waiting?.agentId !== agentId) return undefined;
  const { content, attachments } = waiting;
  waiting = undefined;
  return { content, attachments };
}
