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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof agentSchema>;

export const createAgentSchema = z.object({
  name: z.string().min(1).max(80),
  purpose: z.string().min(1).max(2000),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

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
