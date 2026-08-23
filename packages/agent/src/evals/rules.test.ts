import { describe, expect, it } from 'vitest';
import { checkReply } from './rules.js';

/**
 * Tests for the measuring instrument.
 *
 * An eval is only as good as its checkers, and the failure that matters here
 * is the false positive: a rule that fires on the plain prose responding.md
 * actually asks for would report the document failing exactly when it is
 * working, and we would rewrite a document that was already correct.
 *
 * So each rule is tested in both directions -- it catches the thing, and it
 * leaves the endorsed alternative alone.
 */

const ids = (reply: string) => checkReply(reply).map((h) => h.rule.id);

describe('catching what the document forbids', () => {
  it('catches bold, headings, bullets, numbers and tables', () => {
    expect(ids('That is **important** to know.')).toContain('bold');
    expect(ids('## Photosynthesis\n\nIt works like this.')).toContain('heading');
    expect(ids('You need:\n- a pen\n- some paper')).toContain('bullet-list');
    expect(ids('Steps:\n1. Read it\n2. Write it')).toContain('numbered-list');
    expect(ids('| Mitosis | Meiosis |\n| --- | --- |')).toContain('table');
  });

  it('catches fenced code and asterisk emphasis', () => {
    expect(ids('Try this:\n```python\nfor i in x:\n```')).toContain('fenced-code');
    expect(ids('This is *really* the key idea.')).toContain('asterisk-emphasis');
  });

  it('catches LaTeX by delimiter and by command', () => {
    expect(ids('The answer is \\( x^2 \\).')).toContain('latex');
    expect(ids('So \\frac{dy}{dx} = 2x.')).toContain('latex');
    expect(ids('$$E = mc^2$$')).toContain('latex');
    expect(ids('Use \\sqrt{16} = 4.')).toContain('latex');
  });

  it('catches the turn-context wrapper being echoed back', () => {
    expect(
      ids('<turn_context> Right now it is Friday </turn_context> It is due Friday.'),
    ).toContain('context-leak');
  });

  it('catches the chatbot voice', () => {
    expect(ids('Great question! The answer is Canberra.')).toContain('praise-opener');
    expect(ids('Sure! Here it is.')).toContain('praise-opener');
    expect(ids('Canberra. Would you like me to explain why?')).toContain('next-step-menu');
    expect(ids('Nice work today 🎉')).toContain('emoji');
  });
});

describe('leaving the endorsed alternative alone', () => {
  it('does not flag the plain-text maths the document asks for', () => {
    // These are lifted almost verbatim from responding.md. If any of them trip
    // a rule, the eval punishes the agent for complying.
    const reply =
      'The derivative of x^2 is 2x. You bring the exponent down front, so 3 * 4 ' +
      'is 12, sqrt(5) is about 2.24, and (a+b)/2 is the midpoint. Roughly 45 degrees, ' +
      'or pi/4 if you prefer radians.';
    expect(checkReply(reply)).toEqual([]);
  });

  it('does not read multiplication as emphasis', () => {
    expect(ids('Work out 3 * 4 * 5 and you get 60.')).not.toContain('asterisk-emphasis');
  });

  it('does not read a year at the start of a sentence as a numbered list', () => {
    expect(ids('1914 was the year it began.\n2026. That is a long time ago.')).not.toContain(
      'numbered-list',
    );
  });

  it('does not read a price as maths', () => {
    // A bare dollar sign is far more likely to be a trip cost than LaTeX.
    expect(ids('The trip costs $40, due on Friday.')).not.toContain('latex');
  });

  it('does not flag a list written as a sentence, which is the whole point', () => {
    const reply = 'You need your student card, a passport photo, and the form from the office.';
    expect(checkReply(reply)).toEqual([]);
  });

  it('does not flag ordinary friendly English as a menu of next steps', () => {
    // "Let me know if" was tried as a rule and removed for exactly this.
    expect(ids('It is due Friday. Let me know if that clashes with something.')).toEqual([]);
  });

  it('reports a clean, well-formed reply as entirely clean', () => {
    const reply =
      'Macbeth is mostly about ambition eating the person who has it. He starts as ' +
      'someone other people trust, and every step he takes to hold onto power costs ' +
      'him more of that. The witches matter less as prophecy than as permission.';
    expect(checkReply(reply)).toEqual([]);
  });
});

describe('severity split', () => {
  it('separates what renders as garbage from what merely sounds like a bot', () => {
    const hits = checkReply('Great question! The **answer** is 42.');
    const bySeverity = Object.fromEntries(hits.map((h) => [h.rule.id, h.rule.severity]));
    expect(bySeverity['bold']).toBe('rendering');
    expect(bySeverity['praise-opener']).toBe('voice');
  });
});
