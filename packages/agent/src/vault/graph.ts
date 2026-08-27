import type { NoteKind, Vault, VaultNote } from './vault.js';

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
  /** Documents are not walked: this graph is of the evidence, not of what was written from it. */
  kind: NoteKind;
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

/**
 * Which course each note is filed under, for every note at once.
 *
 * Walked outward from the courses along links pointing back at them, rather
 * than inward from each note in turn. Two things follow, and both matter.
 *
 * It is breadth-first, so a note reaches the course it is *closest* to. Asking
 * each note separately meant a depth-first walk, which filed a note under
 * whichever course the first branch happened to reach -- an email naming
 * history directly could land in chemistry because it also mentioned a
 * titration.
 *
 * And every note is settled in one pass instead of one traversal each. On a
 * real vault of 1401 notes the old shape took 1.5 seconds of blocked event
 * loop, in a server that has only the one, to answer a request for a picture.
 *
 * Cycles need no special handling here: a note is only ever assigned once, so
 * two notes referring to each other cannot walk in a circle.
 */
function clustersFor(
  courses: ReadonlySet<string>,
  linksFrom: ReadonlyMap<string, string[]>,
): Map<string, string> {
  const linksTo = new Map<string, string[]>();
  for (const [source, targets] of linksFrom) {
    for (const target of targets) {
      linksTo.set(target, [...(linksTo.get(target) ?? []), source]);
    }
  }

  const cluster = new Map<string, string>();
  const queue = [...courses];
  for (const course of courses) cluster.set(course, course);

  for (let at = 0; at < queue.length; at += 1) {
    const current = queue[at] as string;
    const home = cluster.get(current) as string;
    for (const source of linksTo.get(current) ?? []) {
      if (cluster.has(source)) continue;
      cluster.set(source, home);
      queue.push(source);
    }
  }

  return cluster;
}

export async function buildGraph(vault: Vault): Promise<VaultGraph> {
  /*
   * The pages as well as the notes, because a vault is one thing.
   *
   * The pages are what a person reads and the notes are what they were written
   * from, and a picture showing only one of the two is a picture of half a
   * vault. Drawn together, the line from a page to the evidence under it is
   * the most useful edge in the whole graph.
   */
  const [entities, episodes, documents] = await Promise.all([
    vault.list('entity'),
    vault.list('episode'),
    vault.list('document'),
  ]);
  const notes: VaultNote[] = [...entities, ...episodes, ...documents];
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
  const clusters = clustersFor(courses, linksFrom);

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
      cluster: clusters.get(note.name) ?? null,
    };
  });

  return { nodes, edges };
}
