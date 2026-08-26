import { describe, expect, it } from 'vitest';
import { USER_DOC } from './documents.js';

/**
 * The rules that stop a generated profile from libelling a student.
 *
 * This document is read before every reply for as long as it exists, which
 * makes a wrong sentence in it worse than a wrong answer: an answer is visible
 * and forgotten, and this is invisible and permanent.
 *
 * The real vault it will be written from has 205 assignments of 298 showing no
 * recorded submission, because Classroom leaves work in that state unless a
 * student presses a button and plenty of teachers never ask. A writer left to
 * its own devices turns that into "falls behind", and then every conversation
 * this student ever has starts from there.
 */

const body = USER_DOC.body;

describe('what the user document is told to write', () => {
  it('lays out the four things the document holds, in order', () => {
    // A brief with no shape produces a different document every rebuild.
    for (const part of [/Who they are/i, /What they study/i, /What else they do/i]) {
      expect(body).toMatch(part);
    }
    expect(body).toMatch(/four sentences/i);
  });

  it('leaves the subject-or-club judgement to the writer, with a caveat', () => {
    expect(body).toMatch(/a hint rather than an answer/i);
  });

  it('insists a teacher it was given is actually used', () => {
    /*
     * The teachers this can find are scarce and mostly attached to clubs and
     * programmes rather than subjects. A structure that only asked for them
     * beside subjects found four and printed none of them.
     */
    expect(body).toMatch(/every teacher you were given must appear/i);
    expect(body).toMatch(/wastes the only hard fact in here/i);
  });

  it('allows a teacher it was given and forbids filling the gaps', () => {
    /*
     * The first real document said this student takes enriched English with
     * Gillian Shadley. He does not. Nothing in the digest said who teaches
     * anything -- it offered a list of courses and a list of people, and the
     * model paired them, which is what anyone would do.
     */
    expect(body).toMatch(/do not fill the gap/i);
    expect(body).toMatch(/do not guess from the subject/i);
    expect(body).toMatch(/wrong teacher sits in front of every conversation/i);
  });

  it('keeps counts out, which were half the length and none of the use', () => {
    expect(body).toMatch(/Numbers\./);
    expect(body).toMatch(/61 pieces of work/);
  });

  it('says a shorter document is a better one', () => {
    // A budget invites filling. It is a limit, not a quota.
    expect(body).toMatch(/a limit, not a quota/i);
  });

  it('rules out turning counts into a verdict on the student', () => {
    expect(body).toMatch(/never characterise them at all/i);
  });

  it('offers the reasons a record can be incomplete, rather than only forbidding', () => {
    // A rule with no explanation is followed until it is inconvenient.
    expect(body).toMatch(/marked on paper|does not grade in Classroom/i);
  });

  it('rules out characterising the student at all', () => {
    expect(body).toMatch(/behind, weak, disorganised, strong or gifted/i);
    expect(body).toMatch(/not what you think of them/i);
  });

  it('keeps out what expires before the document is rewritten', () => {
    expect(body).toMatch(/deadlines|expires/i);
    expect(body).toMatch(/one tool call away/i);
  });

  it('says it is rewritten whole from the vault, not added to', () => {
    // Otherwise it accumulates courses the student finished years ago.
    expect(body).toMatch(/rewrite it whole|ground truth/i);
  });

  it('names an order to cut in, so a full document degrades predictably', () => {
    expect(body).toMatch(/their year and school come first/i);
  });

  it('bans the markup that costs a character of student per character', () => {
    expect(body).toMatch(/no headings, no bullets/i);
  });

  it('makes the writer place today in the school year', () => {
    /*
     * The document said this student was preparing for an exam and finishing a
     * project, in late August, months after both had ended. The dates were all
     * in the vault; nothing asked the writer to look at them.
     */
    expect(body).toMatch(/say when, not just what/i);
    expect(body).toMatch(/between years/i);
    expect(body).toMatch(/past tense/i);
  });

  it('is small enough to be worth loading', () => {
    // It is a writer's brief, not a turn prompt, but a brief nobody can hold
    // in mind is a brief that gets half followed.
    expect(body.length).toBeLessThan(5000);
  });
});
