import { describe, expect, it } from 'vitest';
import { BROWSER, VAULT_READING } from '../prompts/documents.js';
import { loadSkill } from './skills.js';
import type { ToolContext } from './types.js';

/**
 * The one tool that turns a trigger into instructions.
 *
 * What it returns is the body of a document, verbatim, as a tool result --
 * which lands in the message list and prefix-caches for the rest of the turn.
 * What it refuses matters as much: a skill this student cannot use must not
 * come back as a page of rules about tools that will answer "not available".
 */
describe('skill_load', () => {
  const withVault = { userId: 'u1', agentId: 'a1', vault: {} } as unknown as ToolContext;
  const withoutVault = { userId: 'u1', agentId: 'a1' } as ToolContext;

  const run = (name: string, ctx: ToolContext) =>
    loadSkill.execute({ name } as never, ctx) as Promise<string>;

  it('returns the body of the skill asked for', async () => {
    expect(await run('browser', withoutVault)).toBe(BROWSER.body);
    expect(await run('vault-reading', withVault)).toBe(VAULT_READING.body);
  });

  it('lists what exists when asked for a skill that does not', async () => {
    const reply = await run('cooking', withVault);
    expect(reply).toMatch(/no skill called "cooking"/i);
    expect(reply).toContain('browser');
    expect(reply).toContain('vault-reading');
  });

  it('lists only what this student has', async () => {
    const reply = await run('cooking', withoutVault);
    expect(reply).toContain('browser');
    expect(reply).not.toContain('vault-reading');
  });

  it('refuses a vault skill to a student with no vault, and says why', async () => {
    const reply = await run('vault-reading', withoutVault);
    expect(reply).not.toBe(VAULT_READING.body);
    expect(reply).toMatch(/not available/i);
    expect(reply).toMatch(/vault/i);
  });

  it('needs no OAuth scope', () => {
    expect(loadSkill.requiredScopes).toBeUndefined();
  });

  it('tells the model to load only what the turn needs', () => {
    expect(loadSkill.description).toMatch(/only when the turn needs it/i);
  });
});
