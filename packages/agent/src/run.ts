import type { AgentActivity } from '@contexto/shared';
import type { ChatMessage, LlmRegistry } from '@contexto/llm';
import { RESPONDING } from './prompts/documents.js';
import type { MemoryStore } from './memory/types.js';
import type { SkillRegistry } from './skills/types.js';
import type { GoogleTokenProvider, ToolContext, PortalSnapshotSource } from './tools/types.js';
import type { AudioTranscriber } from './tools/transcribe.js';
import type { YoutubeMetadataSource, YoutubeTranscriptSource } from './tools/web/youtube.js';
import type { ToolRegistry } from './tools/registry.js';

/**
 * One turn of an agent.
 *
 * Gather context (memory + skills), call the model, run whatever tools it asks
 * for, feed the results back, repeat until it stops calling tools. Then write
 * what happened to memory so the next turn has it.
 */

export interface AgentRunDeps {
  llm: LlmRegistry;
  memory: MemoryStore;
  skills: SkillRegistry;
  tools: ToolRegistry;
}

export interface AgentRunInput {
  userId: string;
  agentId: string;
  /** The agent's student-authored purpose. Anchors the system prompt. */
  purpose: string;
  message: string;
  /**
   * IANA timezone. Defaults to UTC.
   *
   * Without this the agent cannot resolve "tomorrow at 3pm" into a timestamp
   * and will either interrogate the student or silently guess.
   */
  timezone?: string;
  /** Supplied when the student has connected Google. Omitted otherwise. */
  google?: GoogleTokenProvider;
  /** Supplied when the deployment can transcribe audio. Omitted otherwise. */
  transcriber?: AudioTranscriber;
  /** Supplied when the deployment can look up YouTube metadata. */
  youtube?: YoutubeMetadataSource;
  /** Supplied when the deployment has a transcript service key. */
  youtubeTranscripts?: YoutubeTranscriptSource;
  /** Supplied when a residential proxy is configured. */
  residentialFetch?: typeof globalThis.fetch;
  /** Portal snapshots pushed up by the student's linked desktop companion. */
  portals?: PortalSnapshotSource;
  /**
   * Told what the turn is doing, each time that changes.
   *
   * A notification and nothing more: the turn does not wait on it, read it
   * back, or behave differently for having one. What the caller does with it
   * -- hold it for a poll to collect, drop it -- is the caller's business.
   */
  onActivity?: (activity: AgentActivity) => void;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  reply: string;
  toolsUsed: string[];
}

/**
 * Bounds the tool loop.
 *
 * A model that keeps calling tools has to terminate somewhere, and every
 * iteration is a paid round trip. Eight is enough for a genuinely multi-step
 * task and cheap enough that a stuck agent is not an expensive one.
 */
const MAX_ITERATIONS = 8;

/**
 * The model's text, as a string, whatever it actually sent.
 *
 * A response carrying no text has no text field -- the OpenAI adapter passes
 * `output_text` straight through and that is simply absent when there is
 * nothing to say. Treating it as a string and calling .trim() threw, and it
 * threw in exactly the case the fallback below exists to rescue, so the turn
 * died instead of answering. Everything the model says is normalised on the
 * way in rather than guarded at each use.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function runAgentTurn(
  deps: AgentRunDeps,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  const { llm, memory, skills, tools } = deps;

  const [recalled, availableSkills] = await Promise.all([
    memory.recall(input.agentId),
    skills.list(input.agentId),
  ]);

  const messages: ChatMessage[] = [
    // Static for the whole conversation, so it caches. Anything that changes
    // between turns goes in the user message instead -- see buildTurnContext.
    { role: 'system', content: buildSystemPrompt(input.purpose, availableSkills) },
    {
      role: 'user',
      content: buildUserMessage(buildTurnContext(recalled, input.timezone), input.message),
    },
  ];

  const toolContext: ToolContext = {
    userId: input.userId,
    agentId: input.agentId,
    signal: input.signal,
    ...(input.google ? { google: input.google } : {}),
    ...(input.transcriber ? { transcriber: input.transcriber } : {}),
    ...(input.youtube ? { youtube: input.youtube } : {}),
    ...(input.youtubeTranscripts ? { youtubeTranscripts: input.youtubeTranscripts } : {}),
    ...(input.residentialFetch ? { residentialFetch: input.residentialFetch } : {}),
    ...(input.portals ? { portals: input.portals } : {}),
  };

  // Empty rather than [] -- some providers reject a zero-length tools array,
  // and until OAuth exists no student has any tools registered.
  const toolDefinitions = tools.ids().length > 0 ? tools.toDefinitions() : undefined;

  const toolsUsed: string[] = [];
  let reply = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    input.onActivity?.({ kind: 'thinking' });
    const response = await llm.chat(
      { messages, tools: toolDefinitions },
      { userId: input.userId, agentId: input.agentId, signal: input.signal },
    );

    if (response.toolCalls.length === 0) {
      reply = text(response.content);
      break;
    }

    // Carry the tool calls, not just the text: providers require the original
    // call to be replayed before its result.
    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      toolsUsed.push(call.name);
      input.onActivity?.({ kind: 'tool', name: call.name });
      const result = await tools.execute(call.name, call.arguments, toolContext);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // The loop ran out of iterations while still calling tools. Rather than
  // returning nothing, ask once more with tools withheld -- the model has all
  // the results it gathered and is forced to answer from them. A student
  // getting a partial answer beats a student getting silence.
  if (!reply.trim()) {
    const final = await llm.chat(
      { messages },
      { userId: input.userId, agentId: input.agentId, signal: input.signal },
    );
    reply = text(final.content);
  }

  /*
   * A turn always says something.
   *
   * Asking again usually produces an answer, and when it does not this is
   * what stands between the student and an empty bubble -- which is the worst
   * possible ending, because the work visibly happened. They watched a
   * browser open a page and were then told nothing whatsoever about it.
   *
   * The tools are named because they are the only honest thing left to say:
   * something was done, the model would not describe it, and the student
   * should be told that rather than left to guess.
   */
  if (!reply.trim()) {
    reply = toolsUsed.length
      ? `I did the work (${[...new Set(toolsUsed)].join(', ')}) but could not put an answer ` +
        'together from it. Ask me again and I will try to say what I found.'
      : 'I could not come up with an answer to that. Try asking me again, or in another way.';
  }

  /*
   * Record the exchange verbatim.
   *
   * The instinct to filter here -- only remember "important" turns -- is worth
   * resisting. Curation is what the summarisation job is for, and it can judge
   * significance with the whole period in view, which a single turn cannot.
   * Filtering at write time throws away context before anything has had the
   * chance to decide it mattered, and the loss is silent and unrecoverable.
   *
   * Cost is bounded on the read side, not the write side: recall() takes the
   * most recent N entries and the summaries, never the whole log.
   */
  await memory.record({
    agentId: input.agentId,
    kind: 'conversation',
    content: `Student: ${input.message}\nAgent: ${reply}`,
    source: 'agent_run',
  });

  return { reply, toolsUsed };
}

/**
 * Assemble the system prompt.
 *
 * Ordering here is deliberate and worth preserving: stable content first
 * (purpose, then skills), volatile content last (memory). Providers cache on a
 * prefix match, so anything that changes per turn invalidates everything after
 * it. Putting recalled memory above the skill list would silently destroy the
 * cache hit rate -- and the cached-token discount is the main thing keeping the
 * platform tier affordable.
 */
/**
 * What the agent is told about sites behind a login.
 *
 * Exported so a test can hold it to the promises it makes. The failure this
 * prevents is not a crash -- it is an agent politely declining, which reads
 * to a student as the product not working.
 */
export const SIGN_IN_SECTION =
  'Sites that need a login:\n' +
  'Some of what this student needs is behind a sign-in -- a school portal, a course site. ' +
  'They have saved the username and password for those on their own computer, in its ' +
  'keychain. You never see it, are never given it, and must never ask for it.\n' +
  'You CAN get at those sites. portal_read returns what was last fetched; portal_refresh ' +
  'makes their computer sign in again and fetch it fresh. When they ask you to log in to a ' +
  'site, check one, or get up-to-date information, call portal_refresh -- that IS logging in, ' +
  'done by their machine with the sign-in they saved.\n' +
  'portal_refresh waits for the work and returns the site itself, so finish the job in this ' +
  'turn: call it, read what comes back, and answer the question. Never end your turn having ' +
  'promised something for later -- if you have the result, use it, and if their computer did ' +
  'not answer, say that plainly instead.\n' +
  'You also have browser_open, which opens any page in their browser and reads it back. It is ' +
  'not only for their connected sites: use it for anything that needs a real browser rather ' +
  'than a plain fetch -- a page that builds itself with JavaScript, a page behind a login they ' +
  'already have, or anything web_read_link could not get. The student sees the browser working ' +
  'in the conversation while you use it.\n' +
  'Never say you cannot handle a password, cannot log in, or that they must sign in by hand. ' +
  'None of it is true here and there is no manual sign-in to send them to. If a site genuinely ' +
  'has no saved sign-in, say so plainly and tell them where to add it: the ContextoAgent app, ' +
  'Settings, Connections, Sites.';

/**
 * Exported for the eval harness, which needs to assemble the real prompt with
 * and without a given document to measure what that document is worth.
 */
export function buildSystemPrompt(
  purpose: string,
  skills: Awaited<ReturnType<SkillRegistry['list']>>,
): string {
  /*
   * Tier 1 -- universal. Byte-identical for every agent on the platform.
   *
   * This is the only run of text a provider can serve from cache across
   * different students, so it goes first and nothing that varies is allowed
   * above it. Adding a section here is close to free; adding one below is not.
   */
  const universal = [
    'You are a personal agent built by a student, for themselves. You belong to ' +
      'them, not to their school.',
    /* How to talk to them. Measured at 15% -> 100% clean replies; see src/evals. */
    RESPONDING.body,
    /*
     * How signing in works here, because the honest default is wrong.
     *
     * Asked to log into a site, a model reaches for the safe answer -- "I
     * cannot handle your password" -- which is true of the model and false of
     * this product. The student's sign-in is already saved on their own
     * machine and the agent never sees it; a tool call makes that machine use
     * it. Without saying so, the agent refuses work it can actually do, and
     * the student is told to go and do by hand a thing that was built to be
     * automatic.
     */
    SIGN_IN_SECTION,
  ];

  /*
   * Tier 2 -- per agent. Stable for one student across a whole conversation.
   */
  const perAgent = [`Your purpose, in their words: ${purpose}`];

  if (skills.length > 0) {
    perAgent.push(
      'Skills you have learned:\n' +
        skills.map((s) => `- ${s.name}: ${s.description}\n  ${s.instructions}`).join('\n'),
    );
  }

  return [...universal, ...perAgent].join('\n\n');
}

/**
 * Everything that changes between turns, kept out of the system prompt.
 *
 * This lives apart from buildSystemPrompt for one measured reason. On the
 * Responses API the system prompt is cached as a whole blob keyed on its exact
 * text, not as a prefix: appending six tokens to a 3,613-token prompt took
 * `cached_tokens` from 3,610 to zero. The message list, by contrast, does
 * prefix-match. So a clock that ticks every minute and a memory block that
 * changes every turn do not merely strand the sections below them -- while
 * they sit in the system prompt, nothing in it caches, ever.
 *
 * Moving them into the turn's own message makes the system prompt
 * byte-identical from one turn to the next, which is the only condition under
 * which any of it caches at all. See src/evals/cache.ts for the measurement,
 * and the probe that established the blob behaviour.
 *
 * The block is labelled because it rides along with the student's message and
 * must not be read as something the student typed.
 */
export function buildTurnContext(
  recalled: Awaited<ReturnType<MemoryStore['recall']>>,
  timezone: string | undefined,
): string {
  const sections = [
    /*
     * Temporal grounding.
     *
     * A model has no clock and no location. Without this it cannot resolve
     * "tomorrow", "this week", or "3pm" into the ISO timestamps the calendar
     * tools require -- so it asks the student what timezone they are in, every
     * time, which reads as the agent being broken.
     */
    currentTimeSection(timezone),
  ];

  if (recalled.summaries.length > 0) {
    sections.push(
      'What you remember from earlier:\n' +
        recalled.summaries.map((s) => `- ${s.summary}`).join('\n'),
    );
  }

  if (recalled.recent.length > 0) {
    sections.push(
      'Recently:\n' + recalled.recent.map((m) => `- [${m.kind}] ${m.content}`).join('\n'),
    );
  }

  return sections.join('\n\n');
}

/**
 * The student's message, with this turn's context riding in front of it.
 *
 * Exported so the eval harness sends exactly what production sends.
 */
export function buildUserMessage(context: string, message: string): string {
  return `<turn_context>\n${context}\n</turn_context>\n\n${message}`;
}

/**
 * Tell the agent when and where it is.
 *
 * Exported for tests -- an off-by-one here silently schedules everything on
 * the wrong day.
 */
export function currentTimeSection(timezone: string | undefined, now = new Date()): string {
  const zone = timezone || 'UTC';

  let local: string;
  let offset: string;
  try {
    local = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(now);
    // The model needs the numeric offset to build a valid ISO string; a zone
    // name alone is not enough, and the offset changes with daylight saving.
    offset =
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(now)
        .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  } catch {
    // An invalid timezone string must not take down the turn.
    return `The current time is ${now.toISOString()} (UTC). Assume UTC unless the student says otherwise.`;
  }

  return (
    `Right now it is ${local} for the student. Their timezone is ${zone} (${offset}).\n` +
    'Use this to resolve relative times like "tomorrow" or "next Tuesday", and always ' +
    'include the offset when passing timestamps to tools. Do not ask the student what ' +
    'timezone they are in -- you already know.'
  );
}
