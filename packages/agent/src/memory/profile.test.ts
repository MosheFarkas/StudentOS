import { describe, expect, it } from 'vitest';
import { PROFILE_CHAR_LIMIT, capProfile, profileSection } from './profile.js';

/**
 * The bound is the mechanism, not a limitation being worked around.
 *
 * Hermes runs an agent's entire persistent memory in 3,575 characters and
 * treats the cap as what forces curation rather than accumulation. Uncapped,
 * this grows back into the flat log of twenty transcripts that was bounded two
 * commits ago -- and it grows in the system prompt, where every byte is paid
 * on every turn of every conversation.
 */

describe('holding the profile to its budget', () => {
  it('leaves a profile that already fits alone', () => {
    const profile = 'Takes chemistry, history and economics. Revises by rewriting notes.';
    expect(capProfile(profile)).toBe(profile);
  });

  it('trims an over-long profile to whole sentences', () => {
    // Cutting mid-word leaves the agent reading half a fact and believing it.
    const long = `${'A fact about this student that runs on. '.repeat(60)}`;
    const capped = capProfile(long);
    expect(capped.length).toBeLessThanOrEqual(PROFILE_CHAR_LIMIT);
    expect(capped.endsWith('.')).toBe(true);
  });

  it('never returns more than the limit even with no sentence break', () => {
    // A model that writes one enormous run-on still has to fit.
    const capped = capProfile('x'.repeat(PROFILE_CHAR_LIMIT * 2));
    expect(capped.length).toBeLessThanOrEqual(PROFILE_CHAR_LIMIT);
  });

  it('trims surrounding whitespace', () => {
    expect(capProfile('  Takes chemistry.  \n\n')).toBe('Takes chemistry.');
  });
});

describe('rendering the profile into the prompt', () => {
  it('labels it so the model knows what it is reading', () => {
    const section = profileSection('Takes chemistry. Revises by rewriting notes.');
    expect(section).toContain('Takes chemistry.');
    expect(section).toMatch(/what you know about this student/i);
  });

  it('shows the agent how full its budget is', () => {
    // Hermes puts the gauge in the prompt so the agent knows when it must
    // evict something rather than simply appending.
    const section = profileSection('Takes chemistry.');
    expect(section).toMatch(/16\/1400 characters/);
  });

  it('is absent entirely when nothing is known yet', () => {
    // A new agent should not carry an empty heading around, and an empty
    // section in the cached prefix costs tokens on every turn forever.
    expect(profileSection('')).toBeNull();
    expect(profileSection('   ')).toBeNull();
  });
});
