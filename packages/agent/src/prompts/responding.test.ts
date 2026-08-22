import { describe, expect, it } from 'vitest';
import { RESPONDING } from './documents.js';

const body = RESPONDING.body;

/**
 * What the agent is told about how to talk.
 *
 * None of this is the kind of failure a type checker sees. The behaviour it
 * replaces was a model writing in its default register -- headings, bold,
 * bullets, LaTeX -- into a surface that renders none of it, so a student read
 * the asterisks and the backslashes as characters. It looked like a broken
 * product and nothing in the suite noticed.
 */
describe('the formatting constraint', () => {
  it('says plainly that nothing is rendered', () => {
    expect(body).toMatch(/displayed as plain text/i);
    expect(body).toMatch(/no markdown renderer and no maths renderer/i);
  });

  it('names both surfaces, so the rule does not read as an app quirk', () => {
    // Telegram sends with no parse_mode. A rule the model thinks applies only
    // to the web app is a rule it will break on the other channel.
    expect(body).toMatch(/in the app and in Telegram/i);
  });

  it('rules out LaTeX', () => {
    expect(body).toMatch(/never latex/i);
  });

  it('gives plain-text maths to use instead of ruling notation out and stopping', () => {
    expect(body).toContain('sqrt(5)');
    expect(body).toContain('(a+b)/2');
  });

  it('keeps links, which are the one thing that does render', () => {
    expect(body).toMatch(/label in square brackets and the address in round/i);
  });

  it('tells it what to write instead of a list, a heading and a bold word', () => {
    // Removing the option without supplying the replacement is how a model
    // ends up writing the same list with dashes typed by hand.
    expect(body).toMatch(/put the list inside a sentence/i);
    expect(body).toMatch(/start a new paragraph instead/i);
    expect(body).toMatch(/rewrite the sentence/i);
  });
});

describe('length and tone', () => {
  it('bans the openers that make a reply sound like a chatbot', () => {
    expect(body).toMatch(/do not open by restating what they asked/i);
    expect(body).toMatch(/do not open by praising the question/i);
  });

  it('bans the closing summary and the menu of next steps', () => {
    expect(body).toMatch(/summarising what you just did/i);
    expect(body).toMatch(/three things you could do next/i);
  });

  it('holds it to one question', () => {
    expect(body).toMatch(/one, not three/i);
  });

  it('stops it promising work for a later turn', () => {
    // Same failure the sign-in section guards against, stated generally:
    // describing the work is not doing the work.
    expect(body).toMatch(/never end a message promising to do something afterwards/i);
  });

  it('rules out emoji unless the student goes first', () => {
    expect(body).toMatch(/no emoji unless they use one first/i);
  });

  it('asks for honesty when the honest answer is unwelcome', () => {
    expect(body).toMatch(/be honest when the honest answer is unwelcome/i);
  });

  it('forbids assuming the student is behind or disorganised', () => {
    expect(body).toMatch(/never assume they are behind, disorganised/i);
  });
});

describe('admin versus graded work', () => {
  it('tells it to just do the admin, without deliberating', () => {
    expect(body).toMatch(/that is admin/i);
    expect(body).toMatch(/no discussion about whether you should/i);
  });

  it('tells it to do study support properly rather than withholding', () => {
    // The failure mode of a tutor-first prompt: it starts Socratising a
    // request to summarise a reading.
    expect(body).toMatch(/that is study support/i);
    expect(body).toMatch(/do it properly, and do it in full/i);
  });

  it('tells it to work through graded work rather than hand it over', () => {
    expect(body).toMatch(/do it with them rather than hand it over finished/i);
    expect(body).toMatch(/what they have written so far/i);
  });

  it('gives the reason once and forbids moralising', () => {
    expect(body).toMatch(/do not lecture them about academic honesty/i);
    expect(body).toMatch(/do not keep circling back to it/i);
  });

  it('leaves the final call with the student, who owns the agent', () => {
    // The identity section promises this agent belongs to them and not to
    // their school. A prompt that stonewalls contradicts the product.
    expect(body).toMatch(/they are the person this agent belongs to/i);
  });
});

/**
 * The document practises what it asks for.
 *
 * Two reasons. A model picks up register from its instructions, so a page of
 * bullets teaching it not to use bullets works against itself. And an editor
 * who adds a bulleted list here has almost certainly stopped believing the
 * rule the list is written under.
 *
 * Headings are the deliberate exception: they structure the document for the
 * model and are never output.
 */
describe('the document itself', () => {
  it('contains no bulleted or numbered lists', () => {
    expect(body).not.toMatch(/^\s*[-*+]\s/m);
    expect(body).not.toMatch(/^\s*\d+\.\s/m);
  });

  it('contains no bold, no tables, and no fenced code', () => {
    expect(body).not.toContain('**');
    expect(body).not.toMatch(/\|.*\|/);
    expect(body).not.toContain('```');
  });

  it('contains no LaTeX, having just told the agent not to write any', () => {
    expect(body).not.toContain('\\frac');
    expect(body).not.toContain('\\(');
    expect(body).not.toContain('$$');
  });
});
