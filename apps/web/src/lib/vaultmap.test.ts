import { describe, expect, it } from 'vitest';
import { depths, neighbours, pick, place, type DocEdge, type DocNode } from './vaultmap.js';

/**
 * The picture of a vault, now that it draws the whole thing.
 *
 * The cylinder drew four thousand notes by three numbers and was unreadable.
 * What makes the same notes legible is that they have a shape now -- a student,
 * the pages about them, and the evidence each page was written from -- so what
 * these tests hold onto is that the shape survives being drawn.
 */

const doc = (name: string, over: Partial<DocNode> = {}): DocNode => ({
  name,
  kind: 'document',
  source: 'agent',
  description: name,
  degree: 0,
  cluster: null,
  ...over,
});

const note = (name: string, cluster: string | null = null): DocNode =>
  doc(name, { kind: 'entity', source: 'classroom', cluster });

const VAULT: DocNode[] = [
  doc('user'),
  doc('school'),
  doc('chats'),
  doc('class-french'),
  doc('class-robotics'),
  note('french-a', 'french-a'),
  note('oral-presentation', 'french-a'),
  note('robotics', 'robotics'),
  note('m0duel-rulebook', 'robotics'),
  note('stray'),
];

const EDGES: DocEdge[] = [
  { from: 'user', to: 'school' },
  { from: 'user', to: 'chats' },
  { from: 'user', to: 'class-french' },
  { from: 'user', to: 'class-robotics' },
  { from: 'class-french', to: 'french-a' },
  { from: 'class-robotics', to: 'robotics' },
  { from: 'oral-presentation', to: 'french-a' },
  { from: 'm0duel-rulebook', to: 'robotics' },
];

describe('how far each thing is from the student', () => {
  it('puts the student at nothing and their pages one hop out', () => {
    const d = depths(VAULT, EDGES);
    expect(d.get('user')).toBe(0);
    expect(d.get('class-french')).toBe(1);
  });

  it('puts what a page was written from beyond the page', () => {
    const d = depths(VAULT, EDGES);
    expect(d.get('french-a')).toBe(2);
    expect(d.get('oral-presentation')).toBe(3);
  });

  it('walks links in either direction', () => {
    // An assignment points at its course; the course does not point back. It is
    // still two hops from the page, and drawing it four would be a lie.
    const d = depths(VAULT, EDGES);
    expect(d.get('m0duel-rulebook')).toBe(3);
  });

  it('keeps something nothing points at, at arm’s length', () => {
    // Eight hundred notes on the real account are joined to nothing. They are
    // real and they belong in the picture.
    expect(depths(VAULT, EDGES).get('stray')).toBeGreaterThan(3);
  });

  it('copes with a vault that has no student page yet', () => {
    const d = depths([doc('school'), note('x')], [{ from: 'school', to: 'x' }]);
    expect(d.get('school')).toBe(0);
  });
});

describe('laying the whole vault out', () => {
  const placed = place(VAULT, EDGES, 900, 700);

  it('puts the student in the middle', () => {
    const user = placed.find((p) => p.node.name === 'user');
    expect([user?.x, user?.y]).toEqual([450, 350]);
  });

  it('draws everything, notes included', () => {
    expect(placed).toHaveLength(VAULT.length);
  });

  it('draws a page bigger than a note, because it is what you are looking for', () => {
    const page = placed.find((p) => p.node.name === 'class-french');
    const leaf = placed.find((p) => p.node.name === 'oral-presentation');
    expect(page?.r ?? 0).toBeGreaterThan(leaf?.r ?? 0);
  });

  it('sets a subject in the same direction as the page describing it', () => {
    /*
     * What stops the outer rings being a smear. A class's work sits on the
     * bearing of its page, so a subject reads as a spoke.
     */
    const angle = (name: string) => {
      const p = placed.find((q) => q.node.name === name);
      return Math.atan2((p?.y ?? 0) - 350, (p?.x ?? 0) - 450);
    };

    expect(Math.abs(angle('class-french') - angle('french-a'))).toBeLessThan(0.6);
  });

  it('does not stack two notes under one page on the same point', () => {
    const a = placed.find((p) => p.node.name === 'french-a');
    const b = placed.find((p) => p.node.name === 'robotics');
    expect(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0))).toBeGreaterThan(1);
  });

  it('draws the same vault the same way every time', () => {
    expect(place(VAULT, EDGES, 900, 700)).toEqual(place(VAULT, EDGES, 900, 700));
  });

  it('keeps everything on the canvas', () => {
    for (const item of place(VAULT, EDGES, 900, 700)) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x).toBeLessThanOrEqual(900);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeLessThanOrEqual(700);
    }
  });

  it('lays out nothing for an empty vault', () => {
    expect(place([], [], 900, 700)).toEqual([]);
  });

  it('handles a vault of a few thousand without falling over', () => {
    const many = [doc('user'), doc('class-french'), note('french-a', 'french-a')];
    for (let i = 0; i < 4000; i += 1) many.push(note(`n-${i}`, 'french-a'));
    const edges = [...EDGES, ...many.slice(3).map((n) => ({ from: 'french-a', to: n.name }))];

    expect(place(many, edges, 900, 700)).toHaveLength(many.length);
  });
});

describe('clicking on something', () => {
  const placed = place(VAULT, EDGES, 900, 700);

  it('finds what is under the point', () => {
    const user = placed.find((p) => p.node.name === 'user');
    expect(pick(placed, user?.x ?? 0, user?.y ?? 0)).toBe('user');
  });

  it('finds nothing in the gaps', () => {
    expect(pick(placed, 2, 2)).toBeNull();
  });

  it('prefers a page when a note is drawn on top of one', () => {
    // At the outer rings the dots are three pixels across. The thing somebody
    // is aiming at is almost always the larger one.
    const overlapping = [
      { node: note('tiny'), x: 100, y: 100, r: 3, depth: 3 },
      { node: doc('class-french'), x: 102, y: 100, r: 20, depth: 1 },
    ];
    expect(pick(overlapping, 100, 100)).toBe('class-french');
  });
});

describe('what a thing is joined to', () => {
  it('finds both directions', () => {
    expect(neighbours(EDGES, 'french-a')).toEqual(new Set(['class-french', 'oral-presentation']));
  });

  it('finds nothing for something joined to nothing', () => {
    expect(neighbours(EDGES, 'stray').size).toBe(0);
  });
});
