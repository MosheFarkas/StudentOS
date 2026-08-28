import { forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force-3d';
import { describe, expect, it } from 'vitest';
import {
  collideRadiusFor,
  drawnRadius,
  linkDistanceFor,
  radiusFor,
  FORCES,
  type DocEdge,
  type DocNode,
} from './vaultmap.js';

/**
 * The rule, actually run.
 *
 * Most of the layout is somebody else's physics and not worth testing. This
 * part is: nodes were settling inside each other, the numbers looked right, and
 * reasoning about them produced a fix that changed nothing on screen. So the
 * forces are built here exactly as the scene builds them, the simulation is
 * run, and the distances are measured rather than argued about.
 */

type Placed = DocNode & { id: string; x?: number; y?: number; z?: number };

const node = (name: string, over: Partial<DocNode> = {}): Placed => ({
  id: name,
  name,
  kind: 'entity',
  source: 'classroom',
  description: 'Assignment',
  degree: 0,
  cluster: null,
  ...over,
});

/** Exactly what VaultScene sets up, so a change there without one here shows. */
function settle(nodes: Placed[], edges: DocEdge[], ticks = 500): Map<string, Placed> {
  const links = edges.map((edge) => ({ source: edge.from, target: edge.to }));

  const simulation = forceSimulation(nodes as never, 3)
    .force('charge', forceManyBody().strength(FORCES.charge))
    .force(
      'link',
      forceLink(links as never)
        .id((n: never) => (n as Placed).id)
        .distance((link: never) => {
          const { source, target } = link as { source: Placed; target: Placed };
          return linkDistanceFor(source, target);
        })
        .strength(FORCES.linkStrength),
    )
    .force(
      'collide',
      forceCollide((n: never) => collideRadiusFor(n as DocNode))
        .strength(FORCES.collideStrength)
        .iterations(FORCES.collideIterations),
    )
    .stop();

  simulation.tick(ticks);
  return new Map(nodes.map((n) => [n.name, n]));
}

/** How far two nodes are from touching. Negative means one is inside the other. */
function clearance(a: Placed, b: Placed): number {
  const apart = Math.hypot(
    (a.x ?? 0) - (b.x ?? 0),
    (a.y ?? 0) - (b.y ?? 0),
    (a.z ?? 0) - (b.z ?? 0),
  );
  return apart - (radiusFor(a) + radiusFor(b));
}

/** The worst overlap anywhere, which is the only number that matters. */
function worstClearance(placed: Map<string, Placed>): number {
  const all = [...placed.values()];
  let worst = Infinity;
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      worst = Math.min(worst, clearance(all[i] as Placed, all[j] as Placed));
    }
  }
  return worst;
}

describe('nothing settles inside anything else', () => {
  it('keeps the school out of the student', () => {
    /*
     * The shape that was wrong on screen: the student drawn at twenty-two units
     * across, their pages at thirteen, every page linked to them.
     */
    const nodes = [
      node('user', { kind: 'document' }),
      node('school', { kind: 'document' }),
      node('class-robotics', { kind: 'document' }),
      node('chats', { kind: 'document' }),
    ];
    const edges = nodes.slice(1).map((n) => ({ from: 'user', to: n.name }));

    expect(worstClearance(settle(nodes, edges))).toBeGreaterThan(0);
  });

  it('keeps a page out of the notes hanging off it', () => {
    // A class page, its course, and the course's work: the densest thing in a
    // real vault, and where a big node has the most neighbours pulling inward.
    const nodes = [
      node('class-french', { kind: 'document' }),
      node('french-a', { description: 'Course', degree: 30 }),
      ...Array.from({ length: 40 }, (_, i) => node(`work-${i}`, { degree: 1 })),
    ];
    const edges = [
      { from: 'class-french', to: 'french-a' },
      ...Array.from({ length: 40 }, (_, i) => ({ from: `work-${i}`, to: 'french-a' })),
    ];

    expect(worstClearance(settle(nodes, edges, 700))).toBeGreaterThan(0);
  });

  it('keeps a crowd of notes out of each other', () => {
    const nodes = Array.from({ length: 120 }, (_, i) => node(`n-${i}`, { degree: 2 }));
    const edges = nodes.slice(1).map((n) => ({ from: 'n-0', to: n.name }));

    expect(worstClearance(settle(nodes, edges, 700))).toBeGreaterThan(0);
  });

  it('keeps a hub out of everything pointing at it', () => {
    /*
     * One course with two hundred pieces of work on it. Every link pulls
     * inward at once, which is the case a soft separation loses.
     */
    const nodes = [
      node('french-a', { description: 'Course', degree: 200 }),
      ...Array.from({ length: 200 }, (_, i) => node(`w-${i}`)),
    ];
    const edges = Array.from({ length: 200 }, (_, i) => ({ from: `w-${i}`, to: 'french-a' }));

    const placed = settle(nodes, edges, 700);
    const hub = placed.get('french-a') as Placed;
    for (const n of nodes.slice(1)) {
      expect(clearance(hub, placed.get(n.name) as Placed)).toBeGreaterThan(0);
    }
  });
});

describe('what is drawn is what is held apart', () => {
  /*
   * The bug that made every fix above look like it had done nothing.
   *
   * The renderer sizes a sphere as `cbrt(val) * nodeRelSize`, and with its
   * default of four every node was drawn at four times the radius the forces
   * were separating. Collision was satisfied and the school was still inside
   * the student, because the two were measuring different spheres.
   */
  const cases: DocNode[] = [
    { name: 'user', kind: 'document', source: 'agent', description: '', degree: 0, cluster: null },
    {
      name: 'class-french',
      kind: 'document',
      source: 'agent',
      description: '',
      degree: 0,
      cluster: null,
    },
    {
      name: 'french-a',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      degree: 9,
      cluster: null,
    },
    {
      name: 'a-file',
      kind: 'entity',
      source: 'drive',
      description: 'File',
      degree: 0,
      cluster: null,
    },
  ];

  it('draws every node at exactly the radius the forces use', () => {
    for (const node of cases) {
      expect(drawnRadius(node)).toBeCloseTo(radiusFor(node), 6);
    }
  });

  it('leaves no node drawn larger than the room it claims', () => {
    // If it were, two touching nodes would visibly overlap however hard
    // collision insisted, because collision would be measuring the wrong thing.
    for (const node of cases) {
      expect(drawnRadius(node)).toBeLessThanOrEqual(collideRadiusFor(node));
    }
  });
});
