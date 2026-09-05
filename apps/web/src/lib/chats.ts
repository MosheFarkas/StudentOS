/**
 * "The chat list has changed."
 *
 * The rail owns the list and the conversation is what changes it -- a chat is
 * named from its first message, and the name arrives with the reply. They are
 * cousins in the tree with no prop between them, and threading one through
 * the shell for a single event would be more wiring than the event is worth.
 *
 * A DOM event rather than a store because there is no state here: the rail
 * already knows how to fetch the list, and this only tells it when.
 */
const CHANGED = 'contexto:chats-changed';

export function chatsChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

export function onChatsChanged(listen: () => void): () => void {
  window.addEventListener(CHANGED, listen);
  return () => window.removeEventListener(CHANGED, listen);
}
