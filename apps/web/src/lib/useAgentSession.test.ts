import { describe, expect, it } from 'vitest';
import { belongsInChat } from './useAgentSession.js';

const CHAT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * Which conversation a browser is allowed to appear in.
 *
 * The rule reads as one line and got written as another: `id && id !== mine`
 * skips a session belonging to someone else, but falls straight through when
 * there is no id at all -- so work nobody asked for appeared in whichever
 * chat happened to be open. These are the four cases that distinguish the
 * two, and the third is the one that was wrong.
 */
describe('belongsInChat', () => {
  it('shows the browser in the conversation that asked for the work', () => {
    expect(belongsInChat(CHAT, CHAT)).toBe(true);
  });

  it('keeps another conversation’s browser out of this one', () => {
    expect(belongsInChat(OTHER, CHAT)).toBe(false);
  });

  it('shows a scheduled sync in no conversation at all', () => {
    // Six-hourly refreshes, "Sync now" from the Sites list, and adding a site
    // all run with no agent. Nobody asked for them from a chat, so there is
    // no chat they belong in -- least of all whichever one is open.
    expect(belongsInChat(null, CHAT)).toBe(false);
  });

  it('treats a missing agent the same as an absent one', () => {
    // The event omits the key rather than sending null when it comes from an
    // older build; both mean "nobody asked".
    expect(belongsInChat(undefined, CHAT)).toBe(false);
  });
});
