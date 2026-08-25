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
  it('puts who teaches what first, as the thing most often needed', () => {
    expect(body).toMatch(/who teaches what/i);
  });

  it('rules out turning counts into a verdict on the student', () => {
    expect(body).toMatch(/never write that a student is behind, weak, disorganised, or failing/i);
    expect(body).toMatch(/judgement about a person/i);
  });

  it('offers the reasons a record can be incomplete, rather than only forbidding', () => {
    // A rule with no explanation is followed until it is inconvenient.
    expect(body).toMatch(/handed in on paper|may not use Classroom for grading/i);
  });

  it('allows the one honest statement about performance', () => {
    // Marks that exist are a fact and are useful. Silence about them would be
    // its own distortion.
    expect(body).toMatch(/where the marks are/i);
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
    expect(body).toMatch(/courses and who teaches them come first/i);
  });

  it('bans the markup that costs a character of student per character', () => {
    expect(body).toMatch(/no headings, no bullets/i);
  });

  it('is small enough to be worth loading', () => {
    // It is a writer's brief, not a turn prompt, but a brief nobody can hold
    // in mind is a brief that gets half followed.
    expect(body.length).toBeLessThan(5000);
  });
});
