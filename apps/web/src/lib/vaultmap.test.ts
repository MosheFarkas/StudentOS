import { describe, expect, it } from 'vitest';
import {
  KEY,
  NAMES_SHOWN,
  importantNames,
  colourFor,
  isLit,
  RESTING,
  labelFor,
  labelHeight,
  labelled,
  litBy,
  neighbours,
  NODE_GAP,
  collideRadiusFor,
  linkDistanceFor,
  radiusFor,
  volumeFor,
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
    expect(radiusFor(node({ name: 'user', kind: 'document' }))).toBeGreaterThan(
      radiusFor(node({ name: 'class-french', kind: 'document' })),
    );
  });

  it('draws a page far bigger than a note', () => {
    /*
     * There are ten pages and three thousand notes. Sized alike the ten are
     * lost, and they are the only things anybody navigates by.
     */
    expect(radiusFor(node({ name: 'class-french', kind: 'document' }))).toBeGreaterThan(
      radiusFor(node({ degree: 40 })) * 2,
    );
  });

  it('draws a note more of the vault points at, larger', () => {
    expect(radiusFor(node({ degree: 6 }))).toBeGreaterThan(radiusFor(node({ degree: 0 })));
  });

  it('stops growing a note past the point of crowding its neighbours', () => {
    expect(radiusFor(node({ degree: 900 }))).toBeLessThanOrEqual(
      radiusFor(node({ description: 'Course' })),
    );
  });

  it('draws a page about a person as a note, because there are hundreds of them', () => {
    /*
     * A vault has ten pages and one of these per person it knows. Filed as a
     * page they came out as hundreds of thirteen-unit spheres, the same size
     * and colour as the classes, and they were most of how big the ball was.
     */
    const person = node({
      name: 'person-mme-rivard',
      kind: 'document',
      description: 'Mme Rivard, as the vault has them',
      degree: 4,
    });

    expect(radiusFor(person)).toBeLessThan(
      radiusFor(node({ name: 'class-french', kind: 'document' })),
    );
    expect(radiusFor(person)).toBe(radiusFor(node({ description: 'Person', degree: 4 })));
  });

  it('draws the smallest note big enough to see', () => {
    // The first version came out about two pixels across on a graph a thousand
    // wide, which is a picture of nothing.
    expect(radiusFor(node({ degree: 0 }))).toBeGreaterThanOrEqual(2);
  });

  it('gives the renderer a volume, because that is what it sizes a sphere by', () => {
    /*
     * A radius handed over as a volume comes out as its cube root. That is
     * exactly the mistake that made every node invisible.
     */
    expect(volumeFor(node({ degree: 0 }))).toBeCloseTo(radiusFor(node({ degree: 0 })) ** 3);
  });
});

describe('what the colours mean', () => {
  const lit = (name: string, joined: string[] = []) => ({ name, joined: new Set(joined) });

  it('leaves everything one quiet colour until something is held', () => {
    /*
     * Three thousand notes each shouting their category is a fruit salad you
     * cannot see a shape in. Colour is what selecting something does.
     */
    expect(colourFor(node({ name: 'user', kind: 'document' }), null)).toBe(RESTING);
    expect(colourFor(node({ description: 'File' }), null)).toBe(RESTING);
  });

  it('colours what is held and everything it touches', () => {
    const held = lit('french-a', ['oral-presentation']);

    expect(colourFor(node({ name: 'french-a', description: 'Course' }), held)).not.toBe(RESTING);
    expect(colourFor(node({ name: 'oral-presentation' }), held)).not.toBe(RESTING);
  });

  it('leaves everything else exactly as visible as it was', () => {
    // Dimming three thousand notes to make one legible leaves a picture of one
    // note. They stay; they just stop saying what kind of thing they are.
    expect(colourFor(node({ name: 'elsewhere' }), lit('french-a'))).toBe(RESTING);
  });

  it('gives the student, their school and their conversations their own', () => {
    const seen = new Set(
      ['user', 'school', 'chats'].map((name) =>
        colourFor(node({ name, kind: 'document' }), lit(name)),
      ),
    );
    expect(seen.size).toBe(3);
  });

  it('colours every class alike, so a class reads as a class', () => {
    expect(colourFor(node({ name: 'class-french', kind: 'document' }), lit('class-french'))).toBe(
      colourFor(node({ name: 'class-robotics', kind: 'document' }), lit('class-robotics')),
    );
  });

  it('colours a person the same whether it is their note or their page', () => {
    // They are one person. Two colours for the note and the page written from
    // it says a vault holds two of everybody.
    expect(
      colourFor(
        node({ name: 'person-mme-rivard', kind: 'document', description: 'Mme Rivard, as had' }),
        lit('person-mme-rivard'),
      ),
    ).toBe(colourFor(node({ name: 'mme-rivard', description: 'Person' }), lit('mme-rivard')));
  });

  it('tells a file the student made from one they were given', () => {
    expect(colourFor(node({ name: 'a', description: 'File', source: 'drive' }), lit('a'))).not.toBe(
      colourFor(node({ name: 'b', description: 'File', source: 'classroom' }), lit('b')),
    );
  });

  it('gives what the student said themselves its own colour', () => {
    expect(colourFor(node({ name: 'a', kind: 'episode', source: 'student' }), lit('a'))).not.toBe(
      colourFor(node({ name: 'b', kind: 'episode', source: 'gmail' }), lit('b')),
    );
  });

  it('has a key entry for every colour it uses', () => {
    // Ten colours of dot and no way to know which is which is decoration,
    // however true the geometry.
    const used = new Set([
      colourFor(node({ name: 'user', kind: 'document' }), lit('user')),
      colourFor(node({ name: 'class-french', kind: 'document' }), lit('class-french')),
      colourFor(node({ name: 'a', description: 'File', source: 'drive' }), lit('a')),
      colourFor(node({ name: 'b', description: 'File', source: 'classroom' }), lit('b')),
      colourFor(node({ name: 'c', kind: 'episode', source: 'classroom' }), lit('c')),
    ]);
    const known = new Set(KEY.map((entry) => entry.colour));
    for (const colour of used) expect(known).toContain(colour);
  });
});

describe('naming things the way a student would', () => {
  it('drops the prefix the filename needs and a person does not', () => {
    expect(labelFor('class-french')).toBe('french');
  });

  it('drops the prefix a page about a person carries too', () => {
    // The page has to be named something other than the note it was written
    // from, but "person mme rivard" is not anybody's name.
    expect(labelFor('person-mme-rivard')).toBe('mme rivard');
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

  it('does not name every person just because a page was written about them', () => {
    /*
     * The landmarks are named because there are ten of them. There are hundreds
     * of people, and naming all of them fills the picture with a wall of text
     * before the notes that matter get a look in.
     */
    const names = importantNames([
      node({ name: 'class-french', kind: 'document' }),
      node({ name: 'person-mme-rivard', kind: 'document', description: 'X, as had', degree: 0 }),
    ]);

    expect(names.has('class-french')).toBe(true);
    expect(names.has('person-mme-rivard')).toBe(false);
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

  it('lights the thing held and its neighbours, and nothing further', () => {
    const lit = litBy(edges, 'french-a');

    expect(isLit(node({ name: 'french-a' }), lit)).toBe(true);
    expect(isLit(node({ name: 'class-french' }), lit)).toBe(true);
    expect(isLit(node({ name: 'user' }), lit)).toBe(false);
  });

  it('lights nothing when nothing is held', () => {
    expect(isLit(node({ name: 'anything' }), litBy(edges, null))).toBe(false);
  });
});

describe('nothing sitting inside anything else', () => {
  const page = node({ name: 'user', kind: 'document' });
  const small = node({ name: 'a-file', description: 'File' });

  it('asks a link between two big pages to be longer than one between two notes', () => {
    /*
     * The rule a flat distance broke. The student is drawn at twenty-two units
     * and their school at thirteen; a link asking for twenty puts one inside
     * the other, whatever the collision force then tries to do about it.
     */
    expect(linkDistanceFor(page, page)).toBeGreaterThan(linkDistanceFor(small, small));
  });

  it('always asks for at least as much room as the two ends take up', () => {
    const pairs: [DocNode, DocNode][] = [
      [page, small],
      [page, page],
      [small, small],
      [node({ description: 'Course' }), page],
    ];
    for (const [a, b] of pairs) {
      expect(linkDistanceFor(a, b)).toBeGreaterThanOrEqual(radiusFor(a) + radiusFor(b));
    }
  });

  it('leaves a gap, so two touching nodes are still two', () => {
    // Spheres that meet exactly read as one shape, and the link between them
    // has nowhere to be drawn.
    expect(linkDistanceFor(small, small) - radiusFor(small) * 2).toBeCloseTo(NODE_GAP);
  });

  it('claims exactly the room the link asks for, so the forces agree', () => {
    /*
     * The two are derived from the same radii on purpose. Where they disagree,
     * whichever is stronger wins by a margin and the result is a node settling
     * partway inside its neighbour.
     */
    const pairs: [DocNode, DocNode][] = [
      [page, small],
      [page, page],
      [small, small],
    ];
    for (const [a, b] of pairs) {
      expect(collideRadiusFor(a) + collideRadiusFor(b)).toBeCloseTo(linkDistanceFor(a, b));
    }
  });

  it('claims more room for a bigger node', () => {
    expect(collideRadiusFor(page)).toBeGreaterThan(collideRadiusFor(small));
  });
});
