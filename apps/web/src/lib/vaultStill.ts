import type { DocEdge, DocNode } from './vaultmap.js';

/**
 * The vault as a still picture: where each dot goes, and which are joined.
 *
 * Positions are hashed from note names rather than simulated, so a note lands
 * in the same place every time it is drawn -- a thumbnail that rearranged
 * itself each time settings opened would look like it was still loading.
 *
 * It is also what gets remembered between visits. The graph behind it is
 * three thousand notes and takes a moment to arrive; a still is a few hundred
 * numbers, so the last one drawn can be on screen before the request is even
 * sent, and the fresh one replaces it in the same places.
 */

export interface Dot {
  x: number;
  y: number;
  r: number;
}

export interface Still {
  dots: Dot[];
  /** Pairs of indexes into dots. */
  links: [number, number][];
}

/* Past a few hundred the dots merge anyway, and the only difference is the work. */
const MOST_DOTS = 260;
const MOST_LINKS = 240;
/* Of the 100-unit square. Short of the edge, so the ball sits inside the frame. */
const BALL = 42;

export function drawStill(nodes: DocNode[], edges: DocEdge[]): Still {
  const drawn = nodes.slice(0, MOST_DOTS);
  const at = new Map(drawn.map((node, i) => [node.name, i]));

  const dots = drawn.map((node) => {
    const seed = hash(node.name);
    /*
     * A point somewhere in a ball, seen from the front. Uniform through the
     * volume rather than across a disc, so the middle is thicker than the
     * rim the way the real thing is, and the nearer half is drawn larger.
     */
    const depth = (seed & 0xfff) / 0xfff;
    const angle = (((seed >>> 12) & 0xfff) / 0xfff) * Math.PI * 2;
    const tilt = (((seed >>> 24) & 0xff) / 0xff) * 2 - 1;
    const radius = Math.cbrt(depth) * BALL;
    const flat = Math.sqrt(1 - tilt * tilt) * radius;
    const towards = (tilt * radius) / BALL;

    return {
      x: round(50 + Math.cos(angle) * flat),
      y: round(50 + Math.sin(angle) * flat),
      r: round(0.55 + (towards + 1) * 0.45),
    };
  });

  const links: [number, number][] = [];
  for (const edge of edges) {
    if (links.length >= MOST_LINKS) break;
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    links.push([from, to]);
  }

  return { dots, links };
}

const keyFor = (userId: string) => `vault-still:${userId}`;

/** Keep the last still drawn, so the next visit has one before the graph arrives. */
export function rememberStill(userId: string, still: Still): void {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(still));
  } catch {
    // Storage refused -- a private window, or a browser told to block it.
    // Nothing to remember it in, and nothing lost but a second on next open.
  }
}

/** The still left by this student, or nothing: never someone else's. */
export function recallStill(userId: string): Still | null {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Still>;
    if (!Array.isArray(parsed.dots) || !Array.isArray(parsed.links)) return null;
    return { dots: parsed.dots, links: parsed.links };
  } catch {
    return null;
  }
}

/* Two decimals: enough to place a dot, few enough to keep the store small. */
const round = (value: number) => Math.round(value * 100) / 100;

/** FNV-1a, so a note lands in the same place every time it is drawn. */
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
