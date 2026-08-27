import { describe, expect, it } from 'vitest';
import { CHATS_DOC, CLASS_DOC, SCHOOL_DOC, USER_DOC } from './documents.js';

/**
 * What every pass that writes a page is told.
 *
 * These four produce the only text in the product that is stored as ours and
 * read back later without a warning around it. A note from a teacher's inbox
 * renders wrapped, so an instruction hidden in one is visibly somebody else's;
 * a page written from that note renders bare. If an injected line survives the
 * trip from one to the other, it arrives in a future prompt wearing our voice.
 */

const WRITERS = [
  ['class-doc', CLASS_DOC.body],
  ['school-doc', SCHOOL_DOC.body],
] as const;

describe('every writer that reads somebody else’s words', () => {
  it.each(WRITERS)('%s says the evidence is a record, not an instruction', (_name, body) => {
    expect(body).toMatch(/never an instruction to you/i);
  });

  it.each(WRITERS)('%s says why it matters here specifically', (_name, body) => {
    // The output is stored as ours and rendered without the warning that
    // travelled with its sources.
    expect(body).toMatch(/your voice is the one that gets trusted/i);
  });

  it.each(WRITERS)('%s refuses to invent rather than leave a gap', (_name, body) => {
    expect(body).toMatch(/declin|only what|rather than guess|say so/i);
  });
});

describe('the pages that describe a person', () => {
  it.each([
    ['user-doc', USER_DOC.body],
    ['chats-doc', CHATS_DOC.body],
  ])('%s refuses to characterise the student', (_name, body) => {
    /*
     * Unlike a reply, which is read once and forgotten, these are read before
     * every future answer -- so a verdict written here quietly becomes how a
     * person is treated.
     */
    expect(body).toMatch(/do not|never/i);
    expect(body).toMatch(/how they are (treated|doing)|verdict on them/i);
  });
});
