/**
 * What a chat is called in the rail.
 *
 * Taken from the message that started it rather than written by a model. A
 * title is read in a list of twenty at a glance, and the first thing a student
 * said is what they will recognise it by -- "what is due friday" is a better
 * label for that conversation than anything a summariser would compose about
 * it, and it costs neither a call nor the wait for one.
 *
 * The limit is the API's: createAgentSchema caps a name at 80 characters, and
 * a title it rejects is a chat that cannot be created.
 */
export const TITLE_LIMIT = 56;

export function chatTitle(firstMessage: string): string {
  const flat = firstMessage.replace(/\s+/g, ' ').trim();
  if (!flat) return 'New chat';

  const trimmed = cut(flat);
  // A trailing full stop is noise in a list; a question mark is the shape of
  // the question and worth keeping.
  const tidied = trimmed.replace(/\.$/, '');
  return tidied ? tidied[0]!.toUpperCase() + tidied.slice(1) : 'New chat';
}

/**
 * Shortened to the limit, at a word boundary where there is one.
 *
 * The hard cut is not a fallback nobody hits: a pasted URL or a long
 * unbroken string has no space to cut at, and overflowing is worse than
 * cutting mid-word.
 */
function cut(text: string): string {
  if (text.length <= TITLE_LIMIT) return text;

  const room = text.slice(0, TITLE_LIMIT - 1);
  const lastSpace = room.lastIndexOf(' ');
  const body = lastSpace > TITLE_LIMIT / 3 ? room.slice(0, lastSpace) : room;
  return `${body.replace(/[\s,;:]+$/, '')}…`;
}
