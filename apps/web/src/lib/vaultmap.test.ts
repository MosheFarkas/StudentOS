import { describe, expect, it } from 'vitest';
import {
  KEY,
  NAMES_SHOWN,
  importantNames,
  colourFor,
  isDimmed,
  labelFor,
  labelHeight,
  labelled,
  litBy,
  neighbours,
  sizeFor,
  type DocEdge,
  type DocNode,
} from './vaultmap.js';

/**
 * Everything about the picture that the physics does not decide.
 *
 * Where things end up is a force simulation, which cannot be tested without a
 * WebGL context and would not be worth testing if it could -- it is somebody
 * else's well-worn code and its whole point is that it settles differently for
 * different vaults. What is worth holding onto is the rest: that a page is
 * findable among four thousand notes, that the colours mean something, and
 * that clicking a thing lights up what it is joined to.
 */

const node = (over: Partial<DocNode> = {}): DocNode => ({
  name: 'x',
  kind: 'entity',
  source: 'classroom',
  description: 'Assignment',
  degree: 0,
  cluster: null,
  ...over,
});

describe('telling the pages from the notes', () => {
  it('draws the student biggest, because everything is written into them', () => {
    expect(sizeFor(node({ name: 'user', kind: 'document' }))).toBeGreaterThan(
      sizeFor(node({ name: 'class-french', kind: 'document' })),
    );
  });

  it('draws a page far bigger than a note', () => {
    /*
     * There are ten pages and four thousand notes. Sized alike, the ten are
     * lost, and they are the only things anybody is navigating by.
     */
    expect(sizeFor(node({ name: 'class-french', kind: 'document' }))).toBeGreaterThan(
      sizeFor(node({ degree: 40 })) * 2,
    );
  });

  it('draws a note more of the vault points at, larger', () => {
    expect(sizeFor(node({ degree: 6 }))).toBeGreaterThan(sizeFor(node({ degree: 0 })));
  });

  it('stops growing a note past the point of crowding its neighbours', () => {
    expect(sizeFor(node({ degree: 900 }))).toBeLessThanOrEqual(
      sizeFor(node({ description: 'Course' })),
    );
  });
});

describe('what the colours mean', () => {
  it('gives the student, their school and their conversations their own', () => {
    const seen = new Set(
      ['user', 'school', 'chats'].map((name) => colourFor(node({ name, kind: 'document' }))),
    );
    expect(seen.size).toBe(3);
  });

  it('colours every class alike, so a class reads as a class', () => {
    expect(colourFor(node({ name: 'class-french', kind: 'document' }))).toBe(
      colourFor(node({ name: 'class-robotics', kind: 'document' })),
    );
  });

  it('tells a file the student made from one they were given', () => {
    /*
     * Files are the largest group in a real vault. One a teacher attached and
     * one out of the student's own Drive are different objects: the first is
     * what they were given, the second is what they made.
     */
    expect(colourFor(node({ description: 'File', source: 'drive' }))).not.toBe(
      colourFor(node({ description: 'File', source: 'classroom' })),
    );
  });

  it('gives what the student said themselves its own colour', () => {
    expect(colourFor(node({ kind: 'episode', source: 'student' }))).not.toBe(
      colourFor(node({ kind: 'episode', source: 'gmail' })),
    );
  });

  it('has a key entry for every colour it uses', () => {
    // Six colours of dot and no way to know which is which is decoration,
    // however true the geometry is.
    const used = new Set([
      colourFor(node({ name: 'user', kind: 'document' })),
      colourFor(node({ name: 'class-french', kind: 'document' })),
      colourFor(node({ description: 'File', source: 'drive' })),
      colourFor(node({ description: 'File', source: 'classroom' })),
      colourFor(node({ kind: 'episode', source: 'classroom' })),
    ]);
    const known = new Set(KEY.map((entry) => entry.colour));
    for (const colour of used) expect(known).toContain(colour);
  });
});

describe('naming things the way a student would', () => {
  it('drops the prefix the filename needs and a person does not', () => {
    expect(labelFor('class-french')).toBe('french');
  });

  it('reads a slug as words', () => {
    expect(labelFor('cold-war-essay')).toBe('cold war essay');
  });

  it('always names the landmarks', () => {
    // A graph whose pages and courses are unlabelled is a field of dots.
    const names = importantNames([
      node({ name: 'class-french', kind: 'document' }),
      node({ name: 'french-a', description: 'Course' }),
      node({ name: 'a-file', description: 'File' }),
    ]);

    expect(names.has('class-french')).toBe(true);
    expect(names.has('french-a')).toBe(true);
    expect(names.has('a-file')).toBe(false);
  });

  it('names the notes the rest of the vault points at most', () => {
    const names = importantNames(
      [
        node({ name: 'much-cited', degree: 40 }),
        node({ name: 'cited', degree: 3 }),
        node({ name: 'lonely', degree: 0 }),
      ],
      2,
    );

    expect(names.has('much-cited')).toBe(true);
    expect(names.has('lonely')).toBe(false);
  });

  it('never names something nothing points at', () => {
    // Eight hundred notes on the real account are joined to nothing. Naming
    // them fills the picture with words about things of no consequence.
    expect(importantNames([node({ name: 'lonely', degree: 0 })], 100).has('lonely')).toBe(false);
  });

  it('shows no more names than a screen can hold', () => {
    const many = Array.from({ length: 4000 }, (_, i) => node({ name: `n-${i}`, degree: 5 }));
    expect(importantNames(many).size).toBe(NAMES_SHOWN);
  });

  it('names whatever is being read, however unimportant it is', () => {
    const leaf = node({ name: 'cold-war-essay' });

    expect(labelled(leaf, new Set(), null)).toBe(false);
    expect(labelled(leaf, new Set(), 'cold-war-essay')).toBe(true);
  });

  it('picks the same names every time, so the picture holds still', () => {
    /*
     * Chosen by importance rather than by where the camera is. Names that
     * appear and vanish as you drift make a map you cannot learn.
     */
    const nodes = [node({ name: 'a', degree: 9 }), node({ name: 'b', degree: 2 })];
    expect(importantNames(nodes)).toEqual(importantNames(nodes));
  });

  it('draws a name big enough to read from where it is worth reading', () => {
    /*
     * The first version used eight units on a graph a thousand across, and the
     * names came out invisible. A label is sized against the distance between
     * notes, not against the dot it sits on.
     */
    expect(labelHeight(node({ name: 'user', kind: 'document' }))).toBeGreaterThan(
      labelHeight(node({ description: 'File' })),
    );
    expect(labelHeight(node({ description: 'File' }))).toBeGreaterThanOrEqual(6);
  });
});

describe('lighting up what a thing is joined to', () => {
  const edges: DocEdge[] = [
    { from: 'user', to: 'class-french' },
    { from: 'class-french', to: 'french-a' },
    { from: 'oral-presentation', to: 'french-a' },
  ];

  it('finds what points at it and what it points at', () => {
    expect(neighbours(edges, 'french-a')).toEqual(new Set(['class-french', 'oral-presentation']));
  });

  it('lights the thing held and its neighbours, and dims the rest', () => {
    const lit = litBy(edges, 'french-a');

    expect(isDimmed(node({ name: 'french-a' }), lit)).toBe(false);
    expect(isDimmed(node({ name: 'class-french' }), lit)).toBe(false);
    expect(isDimmed(node({ name: 'user' }), lit)).toBe(true);
  });

  it('leaves everything lit when nothing is held', () => {
    // A resting graph must not look like one that has been switched off.
    expect(isDimmed(node({ name: 'anything' }), litBy(edges, null))).toBe(false);
  });
});
