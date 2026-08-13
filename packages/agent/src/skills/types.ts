import type { SkillOrigin } from '@contexto/shared';

/**
 * A procedure an agent knows how to carry out.
 *
 * The Hermes-style idea this models: an agent should get better at a specific
 * student's specific problems over time, and the artefact of that improvement
 * should be inspectable rather than buried in weights or an ever-growing prompt.
 * A skill is that artefact -- named, versioned, editable, deletable.
 *
 * `instructions` is natural language, not code. It gets injected into the
 * system prompt when the skill is relevant, which is why keeping the set small
 * matters: every skill is a standing tax on the context window.
 */
export interface Skill {
  id: string;
  agentId: string;
  name: string;
  /** One line. Used to decide whether to load the full instructions. */
  description: string;
  /** The procedure itself. */
  instructions: string;
  /** Tool ids this skill may call. */
  toolIds: string[];
  origin: SkillOrigin;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertSkillInput {
  agentId: string;
  name: string;
  description: string;
  instructions: string;
  toolIds?: string[];
  origin?: SkillOrigin;
}

export interface SkillRegistry {
  list(agentId: string): Promise<Skill[]>;
  get(agentId: string, skillId: string): Promise<Skill | null>;
  /** Creates, or bumps `version` if a skill with that name already exists. */
  upsert(input: UpsertSkillInput): Promise<Skill>;
  remove(agentId: string, skillId: string): Promise<void>;
}
