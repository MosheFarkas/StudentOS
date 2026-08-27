/**
 * Laying a whole vault out flat, pages and notes together.
 *
 * The picture this replaces drew every note on a cylinder -- time along the
 * axis, in-degree toward the core, course around the bearing. Three honest axes
 * and unreadable, because a picture of four thousand things arranged by three
 * numbers is a picture of how many there are.
 *
 * What makes the same four thousand readable is that they now have a shape.
 * There is one page describing the student, a page per class and one per school
 * and conversation, and under those the notes each was written from. So the
 * layout is that hierarchy rather than a physics simulation: rings outward from
 * the student, and everything sitting on the bearing of the page it belongs to.
 *
 * Deterministic, so the same vault draws the same way every time. A layout that
 * settles differently on every load is a lava lamp, and you cannot learn the
 * position of anything in one.
 */

export interface DocNode {
  name: string;
  kind: 'entity' | 'episode' | 'document';
  source: string;
  description: string;
  /** How many other notes point here. */
  degree: number;
  /** The course this belongs to, where it belongs to one. */
  cluster: string | null;
}

export interface DocEdge {
  from: string;
  to: string;
}

export interface Placed {
  node: DocNode;
  x: number;
  y: number;
  r: number;
  /** How far from the student, in hops. 0 is the student themselves. */
  depth: number;
}

/** The page everything else is written into. It sits in the middle. */
const CENTRE = 'user';

/** Radius by depth, as a share of the space available. */
const RING = [0, 0.22, 0.55, 0.82, 0.95];

/** Drawn size by depth. The pages are what a person is looking for. */
const SIZE = [30, 20, 5, 3.5, 3];

/** Room for a label under the outermost ring. */
const PADDING = 44;

/**
 * How far each note is from the student, walking the links.
 *
 * Breadth-first and undirected: a note is as close to the student as the
 * shortest chain of references between them, whichever way the references
 * happen to point. Anything the walk never reaches sits on the outside.
 */
export function depths(nodes: readonly DocNode[], edges: readonly DocEdge[]): Map<string, number> {
  const near = new Map<string, string[]>();
  for (const edge of edges) {
    near.set(edge.from, [...(near.get(edge.from) ?? []), edge.to]);
    near.set(edge.to, [...(near.get(edge.to) ?? []), edge.from]);
  }

  const depth = new Map<string, number>();
  const start = nodes.some((node) => node.name === CENTRE)
    ? CENTRE
    : (nodes.find((node) => node.kind === 'document')?.name ?? nodes[0]?.name);
  if (start === undefined) return depth;

  depth.set(start, 0);
  const queue = [start];
  for (let at = 0; at < queue.length; at += 1) {
    const here = queue[at] as string;
    const next = (depth.get(here) as number) + 1;
    for (const neighbour of near.get(here) ?? []) {
      if (depth.has(neighbour)) continue;
      depth.set(neighbour, next);
      queue.push(neighbour);
    }
  }

  // Unreached notes are real and belong in the picture, at arm's length.
  for (const node of nodes) if (!depth.has(node.name)) depth.set(node.name, RING.length - 1);

  return depth;
}

export function place(
  nodes: readonly DocNode[],
  edges: readonly DocEdge[],
  width: number,
  height: number,
): Placed[] {
  if (nodes.length === 0) return [];

  const cx = width / 2;
  const cy = height / 2;
  const span = Math.max(60, Math.min(width, height) / 2 - PADDING);
  const depth = depths(nodes, edges);

  /*
   * A bearing per page, and everything under a page inherits it.
   *
   * This is what stops the outer rings being a smear: a class's assignments,
   * its files and the mail about it all sit in the same direction as the page
   * describing that class, so a subject reads as a spoke rather than as dots
   * scattered round a circle.
   */
  const pages = nodes
    .filter((node) => node.kind === 'document' && node.name !== CENTRE)
    .sort((a, b) => a.name.localeCompare(b.name));

  const bearing = new Map<string, number>();
  pages.forEach((page, i) => bearing.set(page.name, (i / Math.max(1, pages.length)) * Math.PI * 2));

  /** The page a note hangs from, by the course it clusters to. */
  const pageOfCourse = new Map<string, string>();
  for (const edge of edges) {
    if (!bearing.has(edge.from) || bearing.has(edge.to)) continue;
    if (!pageOfCourse.has(edge.to)) pageOfCourse.set(edge.to, edge.from);
  }

  const angleFor = (node: DocNode): number | null => {
    if (bearing.has(node.name)) return bearing.get(node.name) as number;
    if (node.cluster) {
      const page = pageOfCourse.get(node.cluster);
      if (page && bearing.has(page)) return bearing.get(page) as number;
    }
    return null;
  };

  /*
   * Spread within a bearing, so a spoke is a fan rather than a line.
   *
   * Counted per (bearing, ring) so that two notes at the same depth under the
   * same page never land on the same point.
   */
  const taken = new Map<string, number>();
  const placed: Placed[] = [];
  let loose = 0;

  for (const node of nodes) {
    const d = Math.min(depth.get(node.name) ?? RING.length - 1, RING.length - 1);
    if (node.name === CENTRE) {
      placed.push({ node, x: cx, y: cy, r: SIZE[0] as number, depth: 0 });
      continue;
    }

    const own = angleFor(node);
    // Unattached notes ring the outside evenly rather than piling up at zero.
    const base = own ?? (loose += 1) * 2.399963;
    const slot = `${base.toFixed(3)}:${d}`;
    const nth = taken.get(slot) ?? 0;
    taken.set(slot, nth + 1);

    /*
     * Fanned by a golden angle rather than evenly.
     *
     * An even fan needs to know how many will land in this slot before placing
     * the first, which means two passes. This spreads without counting, and
     * spreads more the more there are, which is the behaviour wanted.
     */
    const fan = own === null ? 0 : (nth * 0.381966 * Math.PI) / Math.max(1, pages.length);
    const angle = base + fan * (nth % 2 === 0 ? 1 : -1);
    const radius = span * (RING[d] as number) * (1 + (nth % 5) * 0.012);

    placed.push({
      node,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      r: SIZE[d] as number,
      depth: d,
    });
  }

  return placed;
}

/**
 * Which node is under a point, if any.
 *
 * Nearest first, and pages win ties: at the outer rings the dots are three
 * pixels across and overlap, and the thing somebody is trying to click is
 * almost always the larger one.
 */
export function pick(placed: readonly Placed[], x: number, y: number): string | null {
  let closest: { name: string; score: number } | null = null;

  for (const item of placed) {
    const distance = Math.hypot(item.x - x, item.y - y);
    // A generous target for the small ones, which are unclickable otherwise.
    if (distance > Math.max(item.r, 6)) continue;
    const score = distance - (item.node.kind === 'document' ? 8 : 0);
    if (!closest || score < closest.score) closest = { name: item.node.name, score };
  }

  return closest?.name ?? null;
}

/** Every note directly joined to this one, in either direction. */
export function neighbours(edges: readonly DocEdge[], name: string): Set<string> {
  const found = new Set<string>();
  for (const edge of edges) {
    if (edge.from === name) found.add(edge.to);
    if (edge.to === name) found.add(edge.from);
  }
  return found;
}
