import { describe, expect, it } from 'vitest';
import { neighbours, pick, place, type DocNode } from './vaultmap.js';

/**
 * The picture of a vault, now that a vault is about ten pages.
 *
 * The one this replaces drew four thousand notes on a cylinder. It was true and
 * unreadable. What matters here is the opposite property: the same vault must
 * draw the same way every time, or it is a lava lamp rather than a diagram.
 */

const node = (name: string, degree = 0): DocNode => ({ name, description: name, degree });

const VAULT = [
  node('user', 5),
  node('chats'),
  node('school'),
  node('class-french'),
  node('class-chemistry'),
  node('class-history'),
];

describe('laying out the pages', () => {
  it('puts the page everything is written into at the centre', () => {
    const placed = place(VAULT, 800, 600);
    const user = placed.find((p) => p.node.name === 'user');

    expect(user?.x).toBe(400);
    expect(user?.y).toBe(300);
  });

  it('puts what they have said above and their school below, as in the diagram', () => {
    const placed = place(VAULT, 800, 600);
    const chats = placed.find((p) => p.node.name === 'chats');
    const school = placed.find((p) => p.node.name === 'school');

    expect(chats?.y).toBeLessThan(300);
    expect(school?.y).toBeGreaterThan(300);
    expect(chats?.x).toBe(400);
  });

  it('does not stack a class on top of the two that have fixed places', () => {
    // An even number of classes spread from angle zero would put two of them
    // exactly where chats and school already are.
    const placed = place(VAULT, 800, 600);
    const fixed = placed.filter((p) => p.node.name === 'chats' || p.node.name === 'school');

    for (const cls of placed.filter((p) => p.node.name.startsWith('class-'))) {
      for (const other of fixed) {
        expect(Math.hypot(cls.x - other.x, cls.y - other.y)).toBeGreaterThan(1);
      }
    }
  });

  it('draws the same vault the same way every time', () => {
    expect(place(VAULT, 800, 600)).toEqual(place(VAULT, 800, 600));
  });

  it('keeps every page on the canvas', () => {
    for (const item of place(VAULT, 800, 600)) {
      expect(item.x - item.r).toBeGreaterThanOrEqual(0);
      expect(item.x + item.r).toBeLessThanOrEqual(800);
      expect(item.y - item.r).toBeGreaterThanOrEqual(0);
      expect(item.y + item.r).toBeLessThanOrEqual(600);
    }
  });

  it('draws a page more of the vault points at larger', () => {
    const placed = place([node('class-french', 0), node('class-history', 4)], 800, 600);
    const [french, history] = placed;

    expect(history?.r ?? 0).toBeGreaterThan(french?.r ?? 0);
  });

  it('lays out nothing for a vault nothing has been written into', () => {
    expect(place([], 800, 600)).toEqual([]);
  });

  it('copes with a vault that has only classes in it', () => {
    const placed = place([node('class-french')], 800, 600);
    expect(placed).toHaveLength(1);
  });
});

describe('clicking on something', () => {
  const placed = place(VAULT, 800, 600);

  it('finds the page under the point', () => {
    const user = placed.find((p) => p.node.name === 'user');
    expect(pick(placed, user?.x ?? 0, user?.y ?? 0)).toBe('user');
  });

  it('finds nothing in the gaps', () => {
    expect(pick(placed, 5, 5)).toBeNull();
  });

  it('prefers the page whose middle is nearer when two overlap', () => {
    const overlapping = [
      { node: node('a'), x: 100, y: 100, r: 40 },
      { node: node('b'), x: 120, y: 100, r: 40 },
    ];
    expect(pick(overlapping, 105, 100)).toBe('a');
  });
});

describe('what a page is joined to', () => {
  const edges = [
    { from: 'user', to: 'class-french' },
    { from: 'user', to: 'school' },
    { from: 'class-french', to: 'school' },
  ];

  it('finds what it points at and what points at it', () => {
    expect(neighbours(edges, 'school')).toEqual(new Set(['user', 'class-french']));
  });

  it('finds nothing for a page joined to nothing', () => {
    expect(neighbours(edges, 'chats').size).toBe(0);
  });
});
