import type { Vault, VaultNote } from './vault.js';

/**
 * The vault reduced to something that can be drawn.
 *
 * Three numbers per note, and every one is a real property of the graph rather
 * than a decoration: how many notes point at it, where it sits in time, and
 * which course it belongs to. Those become distance from the axis, position
 * along it, and bearing around it -- so a picture of this is a picture of the
 * vault, not an illustration of one.
 *
 * Computed here rather than in the browser because all three need the whole
 * vault at once. Shipping five hundred note bodies to a canvas so it can count
 * wikilinks would be sending the library to read one number.
 */

export interface GraphNode {
  name: string;
  kind: 'entity' | 'episode';
  source: string;
  /** What the importer called it: Course, Assignment, Topic, Person. */
  description: string;
  /** How many notes point at this one. Courses are the busiest. */
  degree: number;
  /**
   * Where it sits in time, in milliseconds, or null.
   *
   * An episode has its own moment. An entity does not -- an assignment is not
   * an event -- so it takes the middle of the episodes that happened to it.
   * Null when nothing ever did.
   */
  at: number | null;
  /** The course it belongs to. A course is its own. */
  cluster: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface VaultGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const WIKILINK = /\[\[([^\]]+)\]\]/g;

/** Which course a note is filed under, following one link at a time. */
function clusterOf(
  name: string,
  courses: ReadonlySet<string>,
  linksFrom: ReadonlyMap<string, string[]>,
  seen = new Set<string>(),
): string | null {
  if (courses.has(name)) return name;
  // A vault can contain a cycle if two notes reference each other, and this
  // walks links, so it has to be able to stop.
  if (seen.has(name)) return null;
  seen.add(name);

  for (const target of linksFrom.get(name) ?? []) {
    const found = clusterOf(target, courses, linksFrom, seen);
    if (found) return found;
  }
  return null;
}

export async function buildGraph(vault: Vault): Promise<VaultGraph> {
  const [entities, episodes] = await Promise.all([vault.list('entity'), vault.list('episode')]);
  const notes: VaultNote[] = [...entities, ...episodes];
  const exists = new Set(notes.map((note) => note.name));

  const linksFrom = new Map<string, string[]>();
  const edges: GraphEdge[] = [];
  for (const note of notes) {
    const targets = [...note.body.matchAll(WIKILINK)]
      .map((match) => match[1] as string)
      // A link can point at a note that was never written. Drawing that would
      // be a line to nowhere and a vote for something that does not exist.
      .filter((target) => exists.has(target) && target !== note.name);

    linksFrom.set(note.name, targets);
    for (const target of targets) edges.push({ from: note.name, to: target });
  }

  const degree = new Map<string, number>();
  for (const edge of edges) degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);

  const courses = new Set(
    entities.filter((note) => note.description === 'Course').map((note) => note.name),
  );

  /*
   * When each entity sits, from the episodes that happened to it.
   *
   * Without this every entity has no time and piles up at one end, and the
   * cylinder becomes a wall with a tail rather than a history.
   */
  const times = new Map<string, number[]>();
  for (const episode of episodes) {
    const at = episode.occurred ? Date.parse(episode.occurred) : Number.NaN;
    if (Number.isNaN(at)) continue;
    for (const target of linksFrom.get(episode.name) ?? []) {
      times.set(target, [...(times.get(target) ?? []), at]);
    }
  }

  const nodes: GraphNode[] = notes.map((note) => {
    const own = note.occurred ? Date.parse(note.occurred) : Number.NaN;
    const theirs = times.get(note.name) ?? [];
    const at = !Number.isNaN(own)
      ? own
      : theirs.length > 0
        ? theirs.reduce((sum, value) => sum + value, 0) / theirs.length
        : null;

    return {
      name: note.name,
      kind: note.kind,
      source: note.source,
      description: note.description,
      degree: degree.get(note.name) ?? 0,
      at,
      cluster: clusterOf(note.name, courses, linksFrom),
    };
  });

  return { nodes, edges };
}
