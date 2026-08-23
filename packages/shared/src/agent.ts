import { z } from 'zod';

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * The student-authored description of what this agent is for. Becomes part
   * of the system prompt -- students write this in the GUI, never a prompt box
   * labelled "system prompt".
   */
  purpose: z.string(),
  /**
   * What the agent has worked out about this student, in its own words.
   *
   * Written by the summarisation job, never by the student directly -- but
   * shown to them and erasable by them, because a memory a person cannot read
   * or correct is one they have no reason to trust.
   */
  profile: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof agentSchema>;

/**
 * Editing what the agent remembers about you.
 *
 * Bounded to the same budget the writer works to, so a student cannot paste in
 * something that would be silently trimmed the moment it is read back.
 */
export const updateProfileSchema = z.object({
  profile: z.string().max(1400),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const createAgentSchema = z.object({
  name: z.string().min(1).max(80),
  purpose: z.string().min(1).max(2000),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = createAgentSchema.partial();
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

/** Only roles a student sees. Tool traffic stays inside the turn. */
export const messageRoleSchema = z.enum(['user', 'assistant']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  role: messageRoleSchema,
  content: z.string(),
  toolsUsed: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof messageSchema>;

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(10_000),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * How a skill entered the agent's repertoire.
 *
 * `builtin`  -- shipped by the platform, same for every student.
 * `learned`  -- accumulated by the agent over time (the Hermes-style loop).
 *               Nothing writes this value yet; see packages/agent/src/skills.
 */
export const skillOriginSchema = z.enum(['builtin', 'learned']);
export type SkillOrigin = z.infer<typeof skillOriginSchema>;

export const skillSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  origin: skillOriginSchema,
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

/**
 * What a running turn is doing at this instant.
 *
 * `thinking` -- waiting on the model. `tool` -- running the named tool.
 *
 * Reported live and never persisted: it describes a moment inside a turn, and
 * a moment that has passed is not worth a row. The conversation reads it to
 * name the work on screen rather than spinning a bare "Thinking" through a
 * minute of reading a student's mail.
 */
export const agentActivitySchema = z.union([
  z.object({ kind: z.literal('thinking') }),
  z.object({ kind: z.literal('tool'), name: z.string() }),
]);
export type AgentActivity = z.infer<typeof agentActivitySchema>;
