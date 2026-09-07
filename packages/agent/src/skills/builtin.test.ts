import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS, availableSkills, skillsSection } from './builtin.js';

/**
 * What the prompt says about skills, and which ones a student gets.
 *
 * The block is in the cached prefix, so the property that matters is that it
 * is a pure function of the situation: two students with a vault get the same
 * bytes, and a student without one carries nothing about it.
 */
describe('the built-in skills', () => {
  it('are the three the product has', () => {
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual([
      'browser',
      'vault-reading',
      'vault-writing',
    ]);
  });

  it('offers the browser to everyone', () => {
    expect(availableSkills({ hasVault: false }).map((s) => s.name)).toEqual(['browser']);
  });

  it('offers the vault skills only with a vault', () => {
    expect(availableSkills({ hasVault: true }).map((s) => s.name)).toEqual([
      'browser',
      'vault-reading',
      'vault-writing',
    ]);
  });
});

describe('the skills block', () => {
  it('names the tool that loads one', () => {
    expect(skillsSection({ hasVault: true })).toContain('skill_load');
  });

  it('lists each available skill with its trigger, and nothing of its body', () => {
    const block = skillsSection({ hasVault: true });
    for (const skill of BUILTIN_SKILLS) {
      expect(block).toContain(`- ${skill.name}: ${skill.description}`);
      expect(block).not.toContain(skill.body.slice(0, 200));
    }
  });

  it('says nothing about the vault to a student without one', () => {
    const block = skillsSection({ hasVault: false });
    expect(block).not.toContain('vault-reading');
    expect(block).not.toContain('vault-writing');
  });

  it('tells the model a turn none of them covers needs none of them', () => {
    // The other half of the goal. A list of skills with no permission to
    // ignore it reads as "load something".
    expect(skillsSection({ hasVault: true })).toMatch(/needs none of them/i);
  });

  it('is byte-identical for the same situation', () => {
    expect(skillsSection({ hasVault: true })).toBe(skillsSection({ hasVault: true }));
  });
});
