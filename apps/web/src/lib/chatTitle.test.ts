import { describe, expect, it } from 'vitest';
import { TITLE_LIMIT, chatTitle } from './chatTitle.js';

describe('naming a chat after what started it', () => {
  it('uses the message when it is already short enough', () => {
    expect(chatTitle('What is due Friday?')).toBe('What is due Friday?');
  });

  it('capitalises the first letter, since students do not', () => {
    expect(chatTitle('help me outline my essay')).toBe('Help me outline my essay');
  });

  it('leaves a first word that is already capitalised alone', () => {
    // Not a blanket toUpperCase: "IB syllabus" must not become "IB syllabus"
    // via some scheme that lowercases the rest.
    expect(chatTitle('IB chemistry revision')).toBe('IB chemistry revision');
  });

  it('drops a trailing full stop but keeps a question mark', () => {
    expect(chatTitle('Plan my week.')).toBe('Plan my week');
    expect(chatTitle('What is due?')).toBe('What is due?');
  });

  it('collapses the newlines and runs of spaces a pasted message brings', () => {
    expect(chatTitle('Plan my   week\n\naround   practice')).toBe('Plan my week around practice');
  });

  it('never exceeds the limit', () => {
    const long = 'I need help working out what to revise for my chemistry mock next Thursday';
    expect(chatTitle(long).length).toBeLessThanOrEqual(TITLE_LIMIT);
  });

  it('cuts at a word boundary rather than mid-word', () => {
    const long = 'I need help working out what to revise for my chemistry mock next Thursday';
    const title = chatTitle(long);
    expect(title.endsWith('…')).toBe(true);

    // The cut is a word boundary if what it kept is a prefix of the original
    // and the very next character there is a space -- that is what "did not
    // stop mid-word" actually means.
    const kept = title.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(' ');
  });

  it('still produces something when one word is longer than the limit', () => {
    // No space to cut at. Better a hard cut than a title that overflows the
    // column or fails the API's 80-character check.
    const title = chatTitle('a'.repeat(200));
    expect(title.length).toBeLessThanOrEqual(TITLE_LIMIT);
    expect(title.length).toBeGreaterThan(0);
  });

  it('falls back rather than naming a chat nothing', () => {
    expect(chatTitle('')).toBe('New chat');
    expect(chatTitle('   \n  ')).toBe('New chat');
  });

  it('survives a message that is only punctuation', () => {
    expect(chatTitle('???').length).toBeGreaterThan(0);
  });

  it('fits what the API will accept', () => {
    // createAgentSchema caps name at 80. A title it rejects means a chat that
    // cannot be created at all.
    expect(TITLE_LIMIT).toBeLessThanOrEqual(80);
  });
});
