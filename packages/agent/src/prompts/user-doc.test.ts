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
  it('lays out the sections it holds, in order', () => {
    // A brief with no shape produces a different document every rebuild.
    for (const part of [/Who they are/i, /What they study/i, /What else they do/i]) {
      expect(body).toMatch(part);
    }
  });

  it('says the page is a way in as well as a summary', () => {
    /*
     * The change this document exists to serve.
     *
     * Everything else about a student now lives on a page of its own, and the
     * only thing that says those pages exist is this one. A subject it fails to
     * name is a subject the agent never learns it can look up.
     */
    expect(body).toMatch(/names the other pages|way in/i);
    expect(body).toMatch(
      /never mentions is a class the agent will not know|will not know to look up/i,
    );
  });

  it('requires the links, which the previous version banned', () => {
    expect(body).toMatch(/\[\[class-french\]\]|\[\[page-name\]\]/);
    expect(body).toMatch(/only the page names you were given/i);
  });

  it('refuses a link to a page that does not exist', () => {
    // The agent will keep trying a name it was given, and get nothing back.
    expect(body).toMatch(/does not exist opens nothing/i);
  });

  it('forbids filling in a fact it was not given', () => {
    expect(body).toMatch(/no teacher you were not told about/i);
    expect(body).toMatch(/asked for something and therefore produced it/i);
  });

  it('takes the year as given rather than reading one off a course', () => {
    /*
     * The year has already had the years since counted, which is the thing a
     * writer looking at March's mail cannot do for itself.
     */
    expect(body).toMatch(/Use it as given/i);
    expect(body).toMatch(/do not work one out from a course name/i);
  });

  it('keeps counts out, which were half the length and none of the use', () => {
    expect(body).toMatch(/Numbers/i);
    expect(body).toMatch(/not how many assignments/i);
  });

  it('rules out characterising the student at all', () => {
    expect(body).toMatch(/How to write about how they are doing/i);
    expect(body).toMatch(/becomes how they are treated/i);
  });

  it('keeps out what expires before the document is rewritten', () => {
    expect(body).toMatch(/Anything that expires/i);
    expect(body).toMatch(/when a term changes, not when a week does/i);
  });

  it('keeps everybody but the student out of it', () => {
    expect(body).toMatch(/Anybody else/i);
    expect(body).toMatch(/Teachers are named on the class pages/i);
  });

  it('names an order to cut in, so a full document degrades predictably', () => {
    expect(body).toMatch(/cut in this order/i);
    expect(body).toMatch(/Never cut a subject entirely/i);
  });

  it('requires the markup the previous version stripped', () => {
    expect(body).toMatch(/Markdown, and use it properly/i);
    expect(body).toMatch(/the headings above/i);
  });

  it('is small enough to be worth loading', () => {
    // It is read once at module load, not per turn -- but a document nobody
    // will read is a document nobody will maintain.
    expect(body.length).toBeLessThan(8_000);
  });
});
