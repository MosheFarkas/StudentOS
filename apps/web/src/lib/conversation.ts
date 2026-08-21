import type { Message } from '@contexto/shared';

/**
 * Whether two readings of a conversation are the same one.
 *
 * The app and the website are two windows onto one conversation, and the only
 * thing keeping them together is that both keep asking the server what is
 * there. That means asking often, and almost every answer is identical to the
 * last -- so the comparison decides whether the screen redraws every few
 * seconds or only when something was actually said.
 *
 * Length and the last id are enough because messages are only ever appended.
 * Comparing the whole list would be work done every few seconds to reach the
 * same answer.
 */
export function sameConversation(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  return a[a.length - 1]?.id === b[b.length - 1]?.id;
}
