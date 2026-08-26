import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The prose parts of the system prompt, as markdown documents.
 *
 * What the agent is told about how to behave used to be string literals inside
 * buildSystemPrompt. That is a poor home for prose: it is hard to read at the
 * width a TypeScript literal allows, it turns a change of voice into a code
 * diff, and it puts the agent's manners in the same file as its tool loop.
 * These are documents, so they live as documents, and rewriting how the agent
 * talks is an edit to one file that a non-programmer can make.
 *
 * The frontmatter follows Anthropic's SKILL.md convention -- a name and a
 * description and nothing else -- because the documents most likely to arrive
 * here next are built-in skills, and a skill needs a description that a loader
 * can read to decide whether the body is worth its tokens. Nothing conditional
 * exists yet, so the description is validated rather than used. Validating it
 * now is what makes it trustworthy when something finally reads it.
 *
 * The description never reaches the model. It is there for whoever opens the
 * file next.
 *
 * Two things to know before adding a document here. It is read once, at module
 * load, so the process refuses to start rather than quietly serving a turn
 * with half its instructions. And where the body is placed in buildSystemPrompt
 * decides whether it can be cached: these are static, so they belong in the
 * prefix, above anything that changes between turns.
 */

/**
 * Where the .md files sit at runtime.
 *
 * The server apps run tsx against src directly rather than a build output, and
 * deployment is a git checkout, so the documents are always beside this file.
 * If a bundling step is ever added for the server, the .md files have to be
 * copied into it -- a bundler will not follow a readFileSync.
 */
const DOCUMENTS_DIR = fileURLToPath(new URL('.', import.meta.url));

export interface PromptDocument {
  /** Matches the filename. Names the document in errors and tests. */
  name: string;
  /** What the document covers, for the next person to open it. Never sent to the model. */
  description: string;
  /** Everything below the frontmatter. The only part the model sees. */
  body: string;
}

/** Leading `---` block, up to the closing `---` on its own line. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Read one document, or refuse to start.
 *
 * Every failure here throws. The alternative is an agent that boots fine and
 * has silently lost its voice, which nothing would catch until a student
 * noticed the replies had gone strange.
 *
 * `dir` is a seam for tests, which need to feed it documents that are wrong in
 * specific ways without leaving those documents next to the real ones.
 */
export function loadPromptDocument(name: string, dir = DOCUMENTS_DIR): PromptDocument {
  const path = `${dir}${name}.md`;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`Prompt document ${name}.md is missing from ${dir}`, { cause });
  }

  const frontmatter = FRONTMATTER.exec(raw);
  if (!frontmatter?.[1]) {
    throw new Error(
      `Prompt document ${name}.md needs a --- frontmatter block with name and description`,
    );
  }

  const fields = new Map<string, string>();
  for (const line of frontmatter[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const declaredName = fields.get('name');
  const description = fields.get('description');
  const body = raw.slice(frontmatter[0].length).trim();

  // A name that has drifted from its filename means one of the two is a lie,
  // and the loader is the only place that can still tell.
  if (declaredName !== name) {
    throw new Error(
      `Prompt document ${name}.md declares name "${declaredName ?? ''}", which is not its filename`,
    );
  }
  if (!description) {
    throw new Error(`Prompt document ${name}.md has no description`);
  }
  if (!body) {
    throw new Error(`Prompt document ${name}.md has frontmatter but no body`);
  }

  return { name, description, body };
}

/**
 * How the agent talks to the student.
 *
 * Always loaded. The behaviour it replaces is the model's default register --
 * headings, bullets and LaTeX -- none of which anything in this product
 * renders, so a student saw the asterisks and the backslashes themselves. If a
 * markdown or maths renderer is ever added to both the web app and Telegram,
 * the formatting sections of this document are what should be revisited.
 */
export const RESPONDING = loadPromptDocument('responding');

/**
 * How the summarisation job decides what is worth keeping about a student.
 *
 * Never loaded on a turn. It is the system prompt for the background pass that
 * rewrites the profile between conversations, which is why it costs nothing
 * per turn despite being long.
 */
export const PROFILE_DOC = loadPromptDocument('profile');

/**
 * What an episode is, when to make one, and how to link it.
 *
 * Loaded by every pass that writes into ContextoVault -- mail import,
 * Classroom import, conversation rollup -- and by none that only reads. One
 * definition rather than one per importer, because three importers with three
 * ideas of what an episode is produce a vault with three shapes in it.
 */
/**
 * How to write the document describing a student's school life.
 *
 * Read by the pass that runs after a vault is built. Not loaded on a turn --
 * what it produces is, which is why its rules about judgement are the
 * strictest in this directory.
 */
export const USER_DOC = loadPromptDocument('user-doc');

export const VAULT_WRITING = loadPromptDocument('vault-writing');

/**
 * How to find things in ContextoVault and what its links mean.
 *
 * The counterpart to VAULT_WRITING and deliberately a separate document: an
 * agent answering a student needs to know how to traverse the graph and when a
 * copy is the wrong source, and none of the rules about creating notes. Loading
 * the writing rules on an ordinary turn would spend tokens teaching it to do
 * something it is not being asked to do.
 */
export const VAULT_READING = loadPromptDocument('vault-reading');

/**
 * How one bundle of evidence becomes at most one claim.
 *
 * Read by the proposing half of the interpretation pass. Its most load-bearing
 * paragraph is the one telling the model that declining scores as well as
 * answering: every wrong fact this vault has stored came from a pass that was
 * asked for a name and therefore produced one.
 */
export const INTERPRETING = loadPromptDocument('interpreting');

/**
 * How to try to break a claim before it is stored.
 *
 * The counterpart to INTERPRETING and deliberately a separate document read by
 * a separate call. A model asked to check its own reasoning fails the second
 * time in the direction it failed the first; one that has committed to nothing
 * and is asked only to find the hole does not.
 */
export const REFUTING = loadPromptDocument('refuting');
