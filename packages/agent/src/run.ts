import type { ChatMessage, LlmRegistry } from '@studentos/llm';
import type { MemoryStore } from './memory/types.js';
import type { SkillRegistry } from './skills/types.js';
import type { GoogleTokenProvider, ToolContext } from './tools/types.js';
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
  /** Supplied when the student has connected Google. Omitted otherwise. */
  google?: GoogleTokenProvider;
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
    { role: 'system', content: buildSystemPrompt(input.purpose, recalled, availableSkills) },
    { role: 'user', content: input.message },
  ];

  const toolContext: ToolContext = {
    userId: input.userId,
    agentId: input.agentId,
    signal: input.signal,
    ...(input.google ? { google: input.google } : {}),
  };

  // Empty rather than [] -- some providers reject a zero-length tools array,
  // and until OAuth exists no student has any tools registered.
  const toolDefinitions = tools.ids().length > 0 ? tools.toDefinitions() : undefined;

  const toolsUsed: string[] = [];
  let reply = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const response = await llm.chat(
      { messages, tools: toolDefinitions },
      { userId: input.userId, agentId: input.agentId, signal: input.signal },
    );

    if (response.toolCalls.length === 0) {
      reply = response.content;
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    for (const call of response.toolCalls) {
      toolsUsed.push(call.name);
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
  if (!reply) {
    const final = await llm.chat(
      { messages },
      { userId: input.userId, agentId: input.agentId, signal: input.signal },
    );
    reply = final.content;
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
function buildSystemPrompt(
  purpose: string,
  recalled: Awaited<ReturnType<MemoryStore['recall']>>,
  skills: Awaited<ReturnType<SkillRegistry['list']>>,
): string {
  const sections = [
    'You are a personal agent built by a student, for themselves. You belong to ' +
      'them, not to their school. Be direct and useful; skip preamble.',
    `Your purpose, in their words: ${purpose}`,
  ];

  if (skills.length > 0) {
    sections.push(
      'Skills you have learned:\n' +
        skills.map((s) => `- ${s.name}: ${s.description}\n  ${s.instructions}`).join('\n'),
    );
  }

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
