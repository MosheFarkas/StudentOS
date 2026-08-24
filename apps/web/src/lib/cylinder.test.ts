import { describe, expect, it } from 'vitest';
import { layout, neighbours, pick, project, type GraphNode } from './cylinder.js';

/**
 * The shape has to mean something.
 *
 * Every axis carries a real property -- time along, how-many-point-at-it
 * outward, which-course around -- so these check that the geometry says what it
 * claims. A picture where the busiest note is not in the middle is a decoration
 * of a graph rather than a picture of one.
 */

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  name: 'n',
  kind: 'entity',
  source: 'classroom',
  description: 'Assignment',
  degree: 0,
  at: null,
  cluster: 'history',
  ...over,
});

describe('where a node sits', () => {
  it('puts the busiest note nearest the axis', () => {
    const [course, leaf] = layout([
      node({ name: 'history', description: 'Course', degree: 40 }),
      node({ name: 'one-essay', degree: 0 }),
    ]);

    expect(course!.radius).toBeLessThan(leaf!.radius);
  });

  it('lays time out along the cylinder, earliest to the left', () => {
    const [early, late] = layout([
      node({ name: 'september', at: Date.parse('2026-09-01') }),
      node({ name: 'june', at: Date.parse('2026-06-01') }),
    ]);

    // september was passed first but happened later, so it must sit further right.
    expect(early!.x).toBeGreaterThan(late!.x);
  });

  it('gives different courses different bearings', () => {
    const placed = layout([
      node({ name: 'a', cluster: 'history', degree: 0 }),
      node({ name: 'b', cluster: 'chemistry', degree: 0 }),
    ]);

    const angle = (p: (typeof placed)[number]) => Math.atan2(p.z, p.y);
    expect(Math.abs(angle(placed[0]!) - angle(placed[1]!))).toBeGreaterThan(0.3);
  });

  it('spreads the notes that belong to no course all the way round', () => {
    /*
     * A fifth of a real vault has no course -- people, and mail about the
     * school rather than about a class. Handing them one bearing like a
     * fourteenth subject stacks two hundred nodes into a blade, which reads
     * as a rendering fault rather than as what it is: the absence of a
     * course, not a course of its own.
     */
    const placed = layout(
      Array.from({ length: 30 }, (_, i) => node({ name: `n${i}`, cluster: null, degree: 1 })),
    );

    const bearings = placed.map((point) => Math.atan2(point.z, point.y));
    expect(Math.max(...bearings) - Math.min(...bearings)).toBeGreaterThan(4);
  });

  it('still gives each real course one bearing of its own', () => {
    // The spreading must not leak into the courses, or the threads that make
    // the whole shape mean something dissolve into noise.
    const placed = layout(
      Array.from({ length: 12 }, (_, i) => node({ name: `n${i}`, cluster: 'history' })),
    );

    const bearings = placed.map((point) => Math.atan2(point.z, point.y));
    expect(Math.max(...bearings) - Math.min(...bearings)).toBeLessThan(1);
  });

  it('spreads out the notes nothing ever happened to', () => {
    /*
     * An assignment with no episodes has no time. Stacking every one of them at
     * the same point makes a wall, and a wall is not information.
     */
    const placed = layout(Array.from({ length: 10 }, (_, i) => node({ name: `n${i}` })));
    expect(new Set(placed.map((p) => p.x)).size).toBeGreaterThan(5);
  });

  it('survives a vault where nothing has a time at all', () => {
    const placed = layout([node(), node({ name: 'b' })]);
    for (const point of placed) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it('survives an empty vault', () => {
    expect(layout([])).toEqual([]);
  });
});

describe('putting it on a screen', () => {
  const placed = layout([
    node({ name: 'history', description: 'Course', degree: 40, at: Date.parse('2026-06-01') }),
    node({ name: 'essay', degree: 1, at: Date.parse('2026-09-01') }),
  ]);
  const camera = { spin: 0.6, tilt: 0.3, zoom: 1 };

  it('draws far things before near ones', () => {
    // Painter's order. Without it a node behind the cylinder is drawn on top of
    // one in front and the shape reads inside out.
    const projected = project(placed, camera, 600, 400);
    for (let i = 1; i < projected.length; i += 1) {
      expect(projected[i - 1]!.depth).toBeGreaterThanOrEqual(projected[i]!.depth);
    }
  });

  it('draws the busiest note biggest', () => {
    const projected = project(placed, camera, 600, 400);
    const course = projected.find((p) => p.placed.node.name === 'history');
    const essay = projected.find((p) => p.placed.node.name === 'essay');
    expect(course!.size).toBeGreaterThan(essay!.size);
  });

  it('keeps everything on the canvas at rest', () => {
    const projected = project(placed, { spin: 0, tilt: 0, zoom: 1 }, 600, 400);
    for (const point of projected) {
      expect(point.screenX).toBeGreaterThan(-600);
      expect(point.screenX).toBeLessThan(1200);
    }
  });

  it('produces finite coordinates whatever the camera does', () => {
    // A depth clamp exists so a node level with the eye cannot divide by zero
    // and take the whole canvas out.
    for (const spin of [0, 1.7, 3.9, -2.2]) {
      for (const tilt of [0, Math.PI / 2, -Math.PI / 2]) {
        for (const point of project(placed, { spin, tilt, zoom: 2.5 }, 600, 400)) {
          expect(Number.isFinite(point.screenX)).toBe(true);
          expect(Number.isFinite(point.screenY)).toBe(true);
        }
      }
    }
  });
});

describe('clicking on something', () => {
  it('finds the node under the pointer', () => {
    const placed = layout([node({ name: 'history', description: 'Course', degree: 40 })]);
    const projected = project(placed, { spin: 0, tilt: 0, zoom: 1 }, 600, 400);
    const target = projected[0]!;

    expect(pick(projected, target.screenX, target.screenY)?.placed.node.name).toBe('history');
  });

  it('finds nothing in empty space', () => {
    const projected = project(layout([node()]), { spin: 0, tilt: 0, zoom: 1 }, 600, 400);
    expect(pick(projected, 5, 5)).toBeNull();
  });
});

describe('what a node is connected to', () => {
  const edges = [
    { from: 'essay', to: 'history' },
    { from: 'quiz', to: 'history' },
    { from: 'history', to: 'school' },
    { from: 'recipe', to: 'kitchen' },
  ];

  it('finds what points at it and what it points at', () => {
    // Both directions. A student asking "what is this connected to" does not
    // mean "what does this link out to" -- an assignment's course is upstream
    // of it and is the most useful thing on the screen.
    expect(neighbours(edges, 'history')).toEqual(new Set(['essay', 'quiz', 'school']));
  });

  it('does not include the node itself', () => {
    expect(neighbours(edges, 'history').has('history')).toBe(false);
  });

  it('stops at one step', () => {
    // One hop, not the whole component. Lighting up everything reachable from
    // a course would light up the entire vault and say nothing.
    expect(neighbours(edges, 'essay')).toEqual(new Set(['history']));
  });

  it('finds nothing for a node with no links', () => {
    expect(neighbours(edges, 'orphan')).toEqual(new Set());
  });
});
