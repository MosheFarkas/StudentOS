import { isUnavailable } from '../tools/google/client.js';

/**
 * Telling a fact about a file from a circumstance around it.
 *
 * The reader records a file it cannot read so it never pays to try again.
 * That is right when the document genuinely holds no text, and badly wrong
 * when the problem is access -- and access is the common case, not the rare
 * one: Drive access is an elective scope, so on an account that has not
 * granted it every read fails, and treating that as "this document is empty"
 * would write a permanent lie onto every file in the vault on the first pass,
 * never to be revisited even after the student granted access.
 *
 * A permission is not a property of a document.
 *
 * Anything unrecognised is treated as a circumstance. Retrying costs one
 * request; marking wrongly costs the file for ever, so the doubt goes to the
 * side that is recoverable.
 */

/** Refusals that describe the document itself, and will not change. */
const ABOUT_THE_FILE = [
  /could not find any readable text/i,
  /could not read the text/i,
  /is a folder, not a document/i,
  /cannot be exported/i,
  /password protected/i,
  /^I cannot read .* yet \(/i,
  /too (big|large)/i,
];

/**
 * The file's text, null when it has none, or a throw when we could not get at it.
 *
 * @throws when the refusal is about access, connection, or anything unfamiliar
 *   -- all of which may succeed later and none of which say anything about
 *   what the file contains.
 */
export function textFromDriveRead(result: unknown): string | null {
  if (isUnavailable(result)) {
    const reason = String((result as { reason?: string }).reason ?? '');
    if (ABOUT_THE_FILE.some((pattern) => pattern.test(reason))) return null;
    throw new Error(reason || 'Drive would not say why it refused');
  }

  const content = (result as { content?: string }).content ?? '';
  return content.trim() === '' ? null : content;
}
