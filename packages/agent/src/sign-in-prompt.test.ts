import { describe, expect, it } from 'vitest';
import { SIGN_IN_SECTION } from './run.js';

/**
 * The agent declining is not a crash, so nothing else catches it. A student
 * asking their agent to log into a site and being told it cannot handle
 * passwords reads as the product being broken, and it is the answer a model
 * reaches for by default.
 */
describe('what the agent is told about signing in', () => {
  it('tells it not to claim it cannot handle a password', () => {
    expect(SIGN_IN_SECTION).toMatch(/never say you cannot handle a password/i);
  });

  it('tells it not to send the student off to sign in by hand', () => {
    expect(SIGN_IN_SECTION).toMatch(/must never ask for it/i);
    expect(SIGN_IN_SECTION).toMatch(/no manual sign-in/i);
  });

  it('says plainly that it can reach those sites', () => {
    expect(SIGN_IN_SECTION).toMatch(/You CAN get at those sites/);
  });

  it('names the tool that does it, and says calling it IS logging in', () => {
    expect(SIGN_IN_SECTION).toContain('portal_refresh');
    expect(SIGN_IN_SECTION).toMatch(/that IS logging in/i);
  });

  it("is clear the password stays on the student's machine", () => {
    expect(SIGN_IN_SECTION).toMatch(/keychain/i);
    expect(SIGN_IN_SECTION).toMatch(/you never see it/i);
  });

  it('gives somewhere real to go when no sign-in is saved', () => {
    expect(SIGN_IN_SECTION).toMatch(/Settings, Connections, Sites/);
  });
});
