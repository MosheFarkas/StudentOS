import { z } from 'zod';
import { BUILTIN_SKILLS, availableSkills } from '../skills/builtin.js';
import type { Tool } from './types.js';

/**
 * Loading a skill.
 *
 * The prompt names each skill and says when it applies; this is how the model
 * gets the rest. The body comes back as an ordinary tool result, which is the
 * right place for it: the message list prefix-caches, so a skill loaded on the
 * first iteration of a turn is served from cache on every later one.
 */

const inputSchema = z.object({
  name: z
    .string()
    .max(40)
    .describe('The skill to load, exactly as it is named in the Skills list.'),
});

export const loadSkill: Tool<z.infer<typeof inputSchema>, string> = {
  id: 'skill_load',
  description:
    'Load the full instructions for one of your skills, by name, before doing what it ' +
    'covers. The Skills list in your instructions says what each one is for. Load a skill ' +
    'only when the turn needs it.',
  inputSchema,
  async execute({ name }, ctx) {
    const situation = { hasVault: Boolean(ctx.vault) };
    const skill = BUILTIN_SKILLS.find((candidate) => candidate.name === name);

    if (!skill) {
      const names = availableSkills(situation).map((candidate) => candidate.name);
      return `There is no skill called "${name}". The ones you have are: ${names.join(', ')}.`;
    }

    if (!skill.available(situation)) {
      // Only the vault skills can be unavailable today. Say what would change
      // that rather than only that it is so.
      return (
        `The ${name} skill is not available for this student: they have no vault yet, ` +
        'because nothing of theirs has been imported.'
      );
    }

    return skill.body;
  },
};
