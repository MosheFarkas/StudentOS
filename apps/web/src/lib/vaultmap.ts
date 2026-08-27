/**
 * What a vault looks like, as a thing you can turn.
 *
 * The layout itself is a force simulation now rather than arithmetic here --
 * bodies that repel, links that pull like rubber bands, and a centre that stops
 * the whole thing drifting apart. Those are the same three forces Obsidian
 * exposes in its graph view, for the same reason: a vault has no natural
 * coordinates, so the only honest arrangement is the one its own links settle
 * into.
 *
 * What stays here is everything the simulation does not decide -- what a thing
 * is called, what colour it is, how big it should be, and what is joined to
 * what. Pure, so it can be tested without a WebGL context.
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

/** The page everything else is written into. */
export const CENTRE = 'user';

/** The pages. */
const PAGE_COLOURS: Record<string, string> = {
  user: '#f0abfc',
  chats: '#34d399',
  school: '#fbbf24',
};
const CLASS = '#a78bfa';

/*
 * The notes, by what they are rather than by which page they hang from.
 *
 * Brighter than the app's own palette, because these sit on near-black: a
 * thousand small points need a ground to be bright against.
 */
const NOTE_COLOURS: Record<string, string> = {
  Course: '#c4b5fd',
  Assignment: '#60a5fa',
  Topic: '#22d3ee',
  Person: '#f0abfc',
  Material: '#fbbf24',
};
const OWN_FILE = '#a3e635';
const GIVEN_FILE = '#fb923c';
const SAID = '#34d399';

export function colourFor(node: DocNode): string {
  if (node.kind === 'document') return PAGE_COLOURS[node.name] ?? CLASS;
  if (node.kind === 'episode') {
    // What the student said themselves is the one thing here they wrote.
    if (node.source === 'student') return SAID;
    return node.source === 'classroom' ? '#94a3b8' : '#7c8bb0';
  }
  if (node.description === 'File') return node.source === 'drive' ? OWN_FILE : GIVEN_FILE;
  return NOTE_COLOURS[node.description] ?? '#8a8fae';
}

/** What the colours mean. Without it, a picture nobody can read. */
export const KEY: { colour: string; label: string }[] = [
  { colour: PAGE_COLOURS.user as string, label: 'You' },
  { colour: CLASS, label: 'Your classes' },
  { colour: PAGE_COLOURS.school as string, label: 'Your school' },
  { colour: PAGE_COLOURS.chats as string, label: 'What you have told it' },
  { colour: NOTE_COLOURS.Course as string, label: 'Courses' },
  { colour: NOTE_COLOURS.Assignment as string, label: 'Work' },
  { colour: NOTE_COLOURS.Material as string, label: 'Readings' },
  { colour: GIVEN_FILE, label: 'Files from class' },
  { colour: OWN_FILE, label: 'Your own files' },
  { colour: '#94a3b8', label: 'Things that happened' },
];

/**
 * How big a thing is drawn.
 *
 * The pages are what somebody is navigating by and there are ten of them; the
 * notes are what they were written from and there are thousands. Sizing them
 * alike would bury the ten. Beyond that, a note more of the vault points at is
 * drawn larger, which is the one thing the graph knows about importance.
 */
export function sizeFor(node: DocNode): number {
  if (node.name === CENTRE) return 90;
  if (node.kind === 'document') return 44;
  if (node.description === 'Course') return 26;
  return Math.min(14, 3 + node.degree * 0.8);
}

/**
 * How tall a name is drawn, in the same units the simulation works in.
 *
 * Sized against the link distance rather than the node: a name has to be
 * readable from far enough away to be worth having, and a label scaled to a
 * three-unit dot is a smudge. The first version used eight units on a graph a
 * thousand across, which is how the names came out invisible.
 */
export function labelHeight(node: DocNode): number {
  if (node.name === CENTRE) return 26;
  if (node.kind === 'document') return 18;
  if (node.description === 'Course') return 12;
  return 8;
}

/** "class-french" is the filename; "French" is what a student calls it. */
export function labelFor(name: string): string {
  return name.replace(/^class-/, '').replaceAll('-', ' ');
}

/**
 * How many names to show at once, at most.
 *
 * Every name is a texture on the graphics card. Three and a half thousand of
 * them costs seconds to build and, at any distance where the whole graph fits
 * on screen, overlaps into a wall of text nobody can read anyway.
 */
export const NAMES_AT_ONCE = 160;

/**
 * Which names to show, given where the camera is.
 *
 * The pages and the courses always: they are the landmarks, and a graph whose
 * landmarks are unlabelled is a field of dots. Everything else earns a name by
 * being near enough to read -- so pulling back shows you the shape and coming
 * in shows you what is in it, which is the behaviour a map has.
 *
 * `near` is whatever the camera is close to, worked out by the caller because
 * only it knows where the camera is.
 */
export function labelled(
  node: DocNode,
  near: ReadonlySet<string>,
  focused: string | null,
  hovered: string | null,
): boolean {
  if (node.kind === 'document') return true;
  if (node.description === 'Course') return true;
  if (node.name === focused || node.name === hovered) return true;
  return near.has(node.name);
}

/**
 * The names worth drawing from where the camera is standing.
 *
 * Nearest first and capped, so flying into a dense cluster names what is in
 * front of you rather than everything behind it as well.
 */
export function nearest(
  placed: readonly { name: string; x?: number; y?: number; z?: number }[],
  camera: { x: number; y: number; z: number },
  within: number,
  most = NAMES_AT_ONCE,
): Set<string> {
  const reach = within * within;

  const close: { name: string; d: number }[] = [];
  for (const node of placed) {
    const dx = (node.x ?? 0) - camera.x;
    const dy = (node.y ?? 0) - camera.y;
    const dz = (node.z ?? 0) - camera.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d <= reach) close.push({ name: node.name, d });
  }

  close.sort((a, b) => a.d - b.d);
  return new Set(close.slice(0, most).map((node) => node.name));
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

/**
 * What is lit when something is held: the thing, and what it touches.
 *
 * Nothing held means everything is lit, which is what stops a resting graph
 * looking like it is switched off.
 */
export function litBy(
  edges: readonly DocEdge[],
  held: string | null,
): { name: string; joined: Set<string> } | null {
  return held ? { name: held, joined: neighbours(edges, held) } : null;
}

export function isDimmed(
  node: DocNode,
  lit: { name: string; joined: Set<string> } | null,
): boolean {
  if (!lit) return false;
  return lit.name !== node.name && !lit.joined.has(node.name);
}

/**
 * The three forces, tuned the way Obsidian tunes its own.
 *
 * Repel separates unrelated notes, link pulls related ones together like a
 * rubber band, and centre stops the whole thing drifting off. On a vault of
 * four thousand the repel has to be gentler than the default or the outer
 * shells fly apart faster than the centre can hold them.
 */
export const FORCES = {
  /** Node repulsion. Negative attracts; this pushes apart. */
  charge: -55,
  /** How long a link wants to be, in world units. */
  linkDistance: 34,
  /** How tightly a link pulls back to that length, 0 to 1. */
  linkStrength: 0.35,
} as const;
