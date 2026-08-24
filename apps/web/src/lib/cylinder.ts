/**
 * Laying the vault out as a cylinder, and projecting it onto a flat canvas.
 *
 * The shape is not decoration. Each axis carries something true:
 *
 *   Along the cylinder is time. Left is the start of what the agent knows,
 *   right is now.
 *   Distance from the axis is how many notes point at a thing. Courses, which
 *   everything belongs to, sit in the core; a single piece of work with nothing
 *   pointing at it sits on the surface.
 *   Bearing around the axis is which course it belongs to, so each subject is a
 *   thread running the length of the whole thing.
 *
 * Written by hand rather than with a 3D library. This is a few hundred points
 * and some lines -- no meshes, no lighting, no textures -- and importing six
 * hundred kilobytes to draw dots would cost a student on a phone more than the
 * feature is worth.
 */

export interface GraphNode {
  name: string;
  kind: 'entity' | 'episode';
  source: string;
  description: string;
  degree: number;
  at: number | null;
  cluster: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Placed {
  node: GraphNode;
  /** Position in the cylinder's own space, before any rotation. */
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** Half-length of the cylinder, in the same arbitrary units as everything else. */
const LENGTH = 1.6;

/** How far the surface sits from the axis. */
const SKIN = 1;

/**
 * Place every node in the cylinder.
 *
 * Nodes with no time at all -- an assignment nothing has ever happened to --
 * are spread along the axis rather than stacked at one end, because a hundred
 * of them at the same point is a wall rather than information.
 */
export function layout(nodes: GraphNode[]): Placed[] {
  const times = nodes.map((node) => node.at).filter((at): at is number => at !== null);
  const earliest = times.length > 0 ? Math.min(...times) : 0;
  const latest = times.length > 0 ? Math.max(...times) : 1;
  const span = Math.max(1, latest - earliest);

  // Bearings are handed out per course, evenly, so subjects do not overlap.
  const clusters = [...new Set(nodes.map((node) => node.cluster).filter(Boolean))].sort() as string[];
  const bearing = new Map(clusters.map((name, i) => [name, (i / clusters.length) * Math.PI * 2]));

  const busiest = Math.max(1, ...nodes.map((node) => node.degree));

  return nodes.map((node, index) => {
    const along = node.at === null ? (index % 21) / 20 : (node.at - earliest) / span;
    const x = (along - 0.5) * 2 * LENGTH;

    /*
     * Busiest at the core, quiet at the surface.
     *
     * Square-rooted because degree is wildly uneven -- one course had forty-nine
     * inbound links and most notes have none -- and a linear scale would leave
     * every leaf pressed against the skin with nothing between.
     */
    const pull = Math.sqrt(node.degree / busiest);
    const radius = SKIN * (1 - pull) + 0.06;

    /*
     * A little jitter per node, so nodes sharing a course and a moment are not
     * drawn exactly on top of each other and countable as one. The multiplier
     * is the golden angle, which is what stops the offsets from falling into
     * step with each other and re-stacking.
     */
    const spread = ((index * 2.399963) % 1) * 0.5 - 0.25;

    /*
     * Belonging to no course is not a course.
     *
     * A fifth of a real vault is people and school-wide mail. Giving them one
     * shared bearing stacks two hundred nodes into a blade that reads as a
     * fault; scattered right round the cylinder they read as what they are,
     * the background the subjects are threaded through.
     */
    const theta =
      node.cluster === null
        ? ((index * 2.399963) % 1) * Math.PI * 2
        : (bearing.get(node.cluster) ?? 0) + spread;

    return { node, x, y: Math.cos(theta) * radius, z: Math.sin(theta) * radius, radius };
  });
}

export interface Camera {
  /** Rotation about the cylinder's own long axis. */
  spin: number;
  /** Tilt of that axis toward the viewer. */
  tilt: number;
  zoom: number;
}

export interface Projected {
  placed: Placed;
  screenX: number;
  screenY: number;
  /** Distance from the camera. Smaller is nearer. */
  depth: number;
  size: number;
}

/** Where the eye sits. Far enough that perspective is gentle rather than fisheye. */
const EYE = 5;

/**
 * Turn cylinder space into screen space.
 *
 * Spin first, then tilt, then a single perspective divide. Sorted far-to-near
 * by the caller so nearer nodes are drawn over further ones.
 */
export function project(
  placed: Placed[],
  camera: Camera,
  width: number,
  height: number,
): Projected[] {
  const scale = Math.min(width, height) * 0.38 * camera.zoom;
  const cosSpin = Math.cos(camera.spin);
  const sinSpin = Math.sin(camera.spin);
  const cosTilt = Math.cos(camera.tilt);
  const sinTilt = Math.sin(camera.tilt);

  return placed
    .map((point) => {
      // About the long axis: y and z turn, x is untouched.
      const y = point.y * cosSpin - point.z * sinSpin;
      const z = point.y * sinSpin + point.z * cosSpin;

      // Then tip the whole axis toward the viewer.
      const x2 = point.x * cosTilt - z * sinTilt;
      const z2 = point.x * sinTilt + z * cosTilt;

      const depth = EYE - z2;
      const perspective = EYE / Math.max(0.5, depth);

      return {
        placed: point,
        screenX: width / 2 + x2 * scale * perspective,
        screenY: height / 2 + y * scale * perspective,
        depth,
        // Degree decides how big a thing reads, perspective does the rest.
        size: (2 + Math.sqrt(point.node.degree) * 1.7) * perspective * camera.zoom,
      };
    })
    .sort((a, b) => b.depth - a.depth);
}

/**
 * Everything one link away, in either direction.
 *
 * Both directions on purpose. Asked what an essay is connected to, the useful
 * answer includes the course it belongs to -- which the essay links out to --
 * and asked about the course, the useful answer is every piece of work that
 * points at it. One hop rather than the whole component, because everything
 * reachable from a course is most of the vault, and lighting up most of the
 * vault says nothing.
 */
export function neighbours(edges: GraphEdge[], name: string): Set<string> {
  const found = new Set<string>();
  for (const edge of edges) {
    if (edge.from === name) found.add(edge.to);
    if (edge.to === name) found.add(edge.from);
  }
  found.delete(name);
  return found;
}

/** The nearest node under the pointer, or nothing. */
export function pick(projected: Projected[], x: number, y: number): Projected | null {
  let best: Projected | null = null;
  for (const point of projected) {
    const reach = Math.max(6, point.size + 3);
    if (Math.abs(point.screenX - x) > reach || Math.abs(point.screenY - y) > reach) continue;
    // Later in the array is nearer, because the array is sorted far-to-near.
    best = point;
  }
  return best;
}
