/**
 * Laying the vault out flat, as the handful of pages it is now.
 *
 * The picture this replaces drew every note -- four thousand of them, on a
 * cylinder, time along the axis and course around it. It was true and it was
 * unreadable: a picture of how much there is rather than of what any of it
 * says, and no student ever learned anything from it about their own school.
 *
 * What is worth drawing is the layer above: about ten pages, each of which a
 * student would recognise. Their classes, their school, what they have told it.
 * At that size the shape is the point rather than the density, so the layout is
 * fixed rather than physical -- the same vault draws the same way every time,
 * which is what makes it a diagram instead of a lava lamp.
 *
 * The arrangement follows the arrows: what a page is written FROM sits around
 * the page written from it.
 */

export interface DocNode {
  name: string;
  description: string;
  /** How many other pages point here. */
  degree: number;
}

export interface DocEdge {
  from: string;
  to: string;
}

export interface Placed {
  node: DocNode;
  x: number;
  y: number;
  /** Drawn radius. Bigger for a page more of the vault points at. */
  r: number;
}

/** The page everything else is written into. It sits in the middle. */
const CENTRE = 'user';

/** The two that are not classes get the top and the bottom, as in the diagram. */
const TOP = 'chats';
const BOTTOM = 'school';

const MIN_RADIUS = 26;
const MAX_RADIUS = 46;

/** Room for a label under the outermost page. */
const PADDING = 56;

export function place(nodes: DocNode[], width: number, height: number): Placed[] {
  if (nodes.length === 0) return [];

  const cx = width / 2;
  const cy = height / 2;
  const ring = Math.max(80, Math.min(width, height) / 2 - MAX_RADIUS - PADDING);

  const centre = nodes.find((node) => node.name === CENTRE);
  const top = nodes.find((node) => node.name === TOP);
  const bottom = nodes.find((node) => node.name === BOTTOM);
  const rest = nodes.filter((node) => node !== centre && node !== top && node !== bottom);

  const placed: Placed[] = [];
  if (centre) placed.push({ node: centre, x: cx, y: cy, r: radiusFor(centre) });
  if (top) placed.push({ node: top, x: cx, y: cy - ring, r: radiusFor(top) });
  if (bottom) placed.push({ node: bottom, x: cx, y: cy + ring, r: radiusFor(bottom) });

  /*
   * The rest spread evenly, starting at the right.
   *
   * Half a step of offset so that an even number of classes does not put two of
   * them exactly where the top and bottom already are.
   */
  const step = rest.length > 0 ? (Math.PI * 2) / rest.length : 0;
  rest.forEach((node, i) => {
    const angle = i * step + step / 2;
    placed.push({
      node,
      x: cx + Math.cos(angle) * ring,
      y: cy + Math.sin(angle) * ring,
      r: radiusFor(node),
    });
  });

  return placed;
}

/**
 * Which page is under a point, if any.
 *
 * Nearest first, so an overlap resolves to the one whose middle is closer
 * rather than to whichever happened to be drawn last.
 */
export function pick(placed: Placed[], x: number, y: number): string | null {
  let closest: { name: string; distance: number } | null = null;

  for (const item of placed) {
    const distance = Math.hypot(item.x - x, item.y - y);
    if (distance > item.r) continue;
    if (!closest || distance < closest.distance) closest = { name: item.node.name, distance };
  }

  return closest?.name ?? null;
}

/** Every page directly joined to this one, in either direction. */
export function neighbours(edges: DocEdge[], name: string): Set<string> {
  const found = new Set<string>();
  for (const edge of edges) {
    if (edge.from === name) found.add(edge.to);
    if (edge.to === name) found.add(edge.from);
  }
  return found;
}

/** A page more of the vault points at is drawn larger. */
function radiusFor(node: DocNode): number {
  if (node.name === CENTRE) return MAX_RADIUS;
  return Math.min(MAX_RADIUS - 8, MIN_RADIUS + node.degree * 3);
}
