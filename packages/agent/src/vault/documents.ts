import { capProfile } from '../memory/profile.js';
import { slugForNote } from './slug.js';
import type { Vault, VaultNote } from './vault.js';

/**
 * The layer a vault is actually read through.
 *
 * Under this sit thousands of notes, one per assignment, email and file. They
 * are the evidence and they stay -- searchable, linkable, the thing a claim can
 * be checked against. But nobody reads four thousand notes, and no prompt holds
 * them, so what an agent reads is this: a page per class, a page about the
 * school, a page of what the student has said, and one page describing them
 * that is written from all the others.
 *
 * Each is written from the sources beneath it, and rewritten whole rather than
 * appended to, because the evidence is ground truth and a document that
 * accumulates ends up describing a student who left two years ago.
 *
 * Only `user.md` is carried into a prompt. The rest are opened by name when a
 * question turns out to be about one of them, which is what keeps a vault of
 * any size to a fixed cost per turn.
 */

/** Written from every other document. The only one read on every turn. */
export const USER_DOC_NAME = 'user';

/** The school, from the vault and from researching it on the open web. */
export const SCHOOL_DOC_NAME = 'school';

/** What has been learned about the student across all their conversations. */
export const CHATS_DOC_NAME = 'chats';

/**
 * What a class document's name begins with.
 *
 * `[[french]]` is already the course note. Without a prefix the document about
 * French would be a second note of that name in another directory, and a
 * wikilink would resolve to either.
 */
export const CLASS_PREFIX = 'class-';

/**
 * Read on every turn, so its budget is the one that is paid for repeatedly.
 *
 * Four times the paragraph it replaces. That buys headings, a line per class
 * and the links out to them -- and costs around 1,250 tokens a turn, which is
 * the price of the agent not having to look up who this student is.
 */
export const USER_DOC_LIMIT = 5000;

/** Opened on demand, so it can afford to say what a subject is properly. */
export const CLASS_DOC_LIMIT = 2500;

/** Opened on demand. Distilled, so a large budget would be filling it for its own sake. */
export const CHATS_DOC_LIMIT = 4000;

/** Opened on demand, and the one document with genuine research behind it. */
export const SCHOOL_DOC_LIMIT = 8000;

export interface DocumentToWrite {
  name: string;
  /** One line, for a reader and for the tool that lists what can be opened. */
  description: string;
  body: string;
  /** A fingerprint of what this was written from, so an unchanged source is not repaid for. */
  sourceHash?: string;
  /** The school document only: when the academic year ends, as `MM-DD`. */
  yearEnds?: string;
  /** Class documents only: whether this is a taught subject rather than a club. */
  academic?: boolean;
  /** The user document only: the student's own name, so a rewrite need not be told it. */
  student?: string;
}

/** The document a subject is written into. Two rooms of one subject share it. */
export function classDocName(subject: string): string {
  return `${CLASS_PREFIX}${slugForNote(subject)}`;
}

/** The document, or null if one has never been written. */
export async function readDocument(vault: Vault, name: string): Promise<VaultNote | null> {
  try {
    return await vault.read('document', name);
  } catch {
    /*
     * A name that is not a name.
     *
     * These arrive from a model choosing what to open, so a malformed one is
     * an ordinary Tuesday rather than a bug. Vault refuses it before it
     * becomes a path; this turns the refusal into an absent document.
     */
    return null;
  }
}

/**
 * The markers that separate our words from other people's, in a page's body.
 *
 * A page renders in the trusted half of a prompt, undefanged -- that is what
 * being ours means. Which makes carrying these the one thing a page must never
 * do: it would blur the only boundary a later reader has. The writers are told
 * not to copy their evidence, and this is the case where being told is not
 * enough, because the cost of being wrong once is every prompt afterwards.
 */
const WRAPPER = /<\/?untrusted>/gi;

export async function writeDocument(vault: Vault, doc: DocumentToWrite): Promise<void> {
  await vault.write({
    name: doc.name,
    kind: 'document',
    /*
     * Ours, not the school's.
     *
     * A document is written by this product from material somebody else wrote,
     * so it renders without the warning that wraps a teacher's email. That is
     * only honest because every writer runs with no tools and a bounded input
     * -- keep that true, or this label stops being.
     */
    source: 'agent',
    description: doc.description,
    ...(doc.sourceHash ? { sourceHash: doc.sourceHash } : {}),
    ...(doc.yearEnds ? { yearEnds: doc.yearEnds } : {}),
    ...(doc.academic === undefined ? {} : { academic: doc.academic }),
    ...(doc.student ? { student: doc.student } : {}),
    body: doc.body.replace(WRAPPER, '').trim(),
  });
}

export async function listDocuments(vault: Vault): Promise<VaultNote[]> {
  return vault.list('document');
}

/**
 * Hold a document to budget without destroying what makes it a document.
 *
 * The paragraph this replaces was capped by stripping every heading, bullet and
 * link and collapsing the result to one line -- correct for prose, fatal for a
 * page whose whole job is to be structured and to link out.
 *
 * So it drops whole sections instead. A document cut here is shorter and still
 * true; a document cut mid-sentence leaves the agent reading half a fact and
 * believing it.
 */
export function capDocument(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;

  /*
   * Cut at the last heading that leaves everything above it intact.
   *
   * The first heading is skipped deliberately: cutting there would leave a
   * title and nothing under it.
   */
  const headings = [...trimmed.matchAll(/^#{1,6} /gm)]
    .map((match) => match.index)
    .filter((at): at is number => at !== undefined && at > 0);

  const fits = headings.filter((at) => at <= limit);
  const lastFitting = fits[fits.length - 1];
  if (lastFitting !== undefined) return trimmed.slice(0, lastFitting).trimEnd();

  // Not even one section fits. Fall back to the sentence cut the profile uses.
  return capProfile(trimmed, limit);
}
