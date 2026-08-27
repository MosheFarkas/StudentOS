import { describe, expect, it } from 'vitest';
import {
  KEY,
  NAMES_AT_ONCE,
  colourFor,
  isDimmed,
  labelFor,
  labelHeight,
  labelled,
  litBy,
  nearest,
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
    const none = new Set<string>();
    expect(labelled(node({ name: 'class-french', kind: 'document' }), none, null, null)).toBe(true);
    expect(labelled(node({ description: 'Course' }), none, null, null)).toBe(true);
  });

  it('names a note once the camera is near it, and not before', () => {
    const leaf = node({ name: 'cold-war-essay' });

    expect(labelled(leaf, new Set(), null, null)).toBe(false);
    expect(labelled(leaf, new Set(['cold-war-essay']), null, null)).toBe(true);
  });

  it('names whatever is being pointed at or read, wherever it is', () => {
    const leaf = node({ name: 'cold-war-essay' });

    expect(labelled(leaf, new Set(), null, 'cold-war-essay')).toBe(true);
    expect(labelled(leaf, new Set(), 'cold-war-essay', null)).toBe(true);
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

describe('which names the camera is close enough to read', () => {
  const at = (name: string, x: number) => ({ name, x, y: 0, z: 0 });

  it('names what is in front of you and not what is behind everything else', () => {
    const near = nearest([at('a', 10), at('b', 500)], { x: 0, y: 0, z: 0 }, 100);
    expect(near).toEqual(new Set(['a']));
  });

  it('takes the nearest first when a cluster is too dense to name whole', () => {
    const many = Array.from({ length: 400 }, (_, i) => at(`n-${i}`, i));
    const near = nearest(many, { x: 0, y: 0, z: 0 }, 1000, 10);

    expect(near.size).toBe(10);
    expect(near.has('n-0')).toBe(true);
    expect(near.has('n-399')).toBe(false);
  });

  it('never names more than a screen can hold', () => {
    const many = Array.from({ length: 4000 }, (_, i) => at(`n-${i}`, 0));
    expect(nearest(many, { x: 0, y: 0, z: 0 }, 1000).size).toBe(NAMES_AT_ONCE);
  });

  it('names nothing when the camera is nowhere near anything', () => {
    expect(nearest([at('a', 0)], { x: 9000, y: 0, z: 0 }, 100).size).toBe(0);
  });

  it('copes with a node the simulation has not placed yet', () => {
    expect(nearest([{ name: 'a' }], { x: 0, y: 0, z: 0 }, 100)).toEqual(new Set(['a']));
  });
});
