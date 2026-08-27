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
 * How many names to show.
 *
 * Every name is a texture on the graphics card, and three and a half thousand
 * of them is both seconds of building and, at any distance where the whole
 * graph fits on screen, a wall of overlapping text. This is about what fits
 * before the names start colliding with each other.
 */
export const NAMES_SHOWN = 120;

/**
 * Which names are worth showing, decided once.
 *
 * The landmarks always -- the pages and the courses -- because a graph whose
 * landmarks are unlabelled is a field of dots. Then the notes the rest of the
 * vault points at most, which is the only thing the graph itself knows about
 * importance.
 *
 * Fixed rather than chosen by where the camera is. Names that appear and
 * vanish as you drift make a picture that will not hold still, and the whole
 * point of a map is that you can learn where things are on it.
 */
export function importantNames(nodes: readonly DocNode[], most = NAMES_SHOWN): Set<string> {
  const names = new Set<string>();
  const rest: DocNode[] = [];

  for (const node of nodes) {
    if (node.kind === 'document' || node.description === 'Course') names.add(node.name);
    else rest.push(node);
  }

  for (const node of [...rest].sort((a, b) => b.degree - a.degree)) {
    if (names.size >= most) break;
    if (node.degree === 0) break;
    names.add(node.name);
  }

  return names;
}

/** Whether this one says what it is: because it matters, or because you are on it. */
export function labelled(node: DocNode, names: ReadonlySet<string>, held: string | null): boolean {
  return names.has(node.name) || node.name === held;
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
