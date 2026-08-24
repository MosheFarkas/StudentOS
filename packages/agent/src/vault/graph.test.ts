import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from './vault.js';
import { buildGraph } from './graph.js';

/**
 * The vault as something that can be drawn.
 *
 * Three numbers per note, and each one is a real property of the graph rather
 * than a decoration: how many notes point at it, when it sits in time, and
 * which course it belongs to. Those become distance from the axis, position
 * along it, and bearing around it.
 *
 * Computed here rather than in the browser because all three need the whole
 * vault at once, and shipping five hundred note bodies to a canvas so it can
 * count wikilinks would be sending the library to read one number.
 */

describe('building the graph', () => {
  let root: string;
  let vault: Vault;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'contexto-graph-'));
    vault = new Vault(root, 'agent-1');

    const entity = (name: string, description: string, body: string) =>
      vault.write({ name, kind: 'entity', source: 'classroom', description, body });

    await entity('history', 'Course', 'History.');
    await entity('chemistry', 'Course', 'Chemistry.');
    await entity('cold-war-essay', 'Assignment', 'Cold War essay.\n\nPart of [[history]].');
    await entity('revolutions', 'Topic', 'Revolutions.\n\nPart of [[history]].');
    await entity('titration', 'Assignment', 'Titration.\n\nPart of [[chemistry]].');

    await vault.write({
      name: '2026-09-02-moved',
      kind: 'episode',
      source: 'gmail',
      description: 'Deadline moved.',
      occurred: '2026-09-02T10:00:00Z',
      body: 'Mrs Bell moved it.\n\nAbout [[cold-war-essay]]\nIn [[history]]',
    });
    await vault.write({
      name: '2026-09-20-graded',
      kind: 'episode',
      source: 'gmail',
      description: 'Marked.',
      occurred: '2026-09-20T10:00:00Z',
      body: 'Marked 18/20.\n\nAbout [[cold-war-essay]]\nIn [[history]]',
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('counts what points at each note', async () => {
    const { nodes } = await buildGraph(vault);
    const by = new Map(nodes.map((node) => [node.name, node]));

    // history is pointed at by two entities and two episodes.
    expect(by.get('history')?.degree).toBe(4);
    expect(by.get('cold-war-essay')?.degree).toBe(2);
    expect(by.get('titration')?.degree).toBe(0);
  });

  it('gives every node the course it belongs to', async () => {
    const { nodes } = await buildGraph(vault);
    const by = new Map(nodes.map((node) => [node.name, node]));

    // A course is its own cluster; everything else takes the course it links to.
    expect(by.get('history')?.cluster).toBe('history');
    expect(by.get('cold-war-essay')?.cluster).toBe('history');
    expect(by.get('2026-09-02-moved')?.cluster).toBe('history');
    expect(by.get('titration')?.cluster).toBe('chemistry');
  });

  it('files a note under the course it is closest to', async () => {
    /*
     * An episode can mention several things, and following its links
     * depth-first files it under whichever course the first branch happened to
     * reach -- here chemistry, two hops away through the titration, rather
     * than the history it names directly.
     *
     * Nearest is the defensible answer, and it is also the one that can be
     * computed by walking out from the courses once instead of walking in from
     * every note separately. On a real vault of 1401 notes that was the
     * difference between 1.5 seconds of blocked event loop and 40ms.
     */
    await vault.write({
      name: '2026-10-01-mentions-both',
      kind: 'episode',
      source: 'gmail',
      description: 'Mentions both.',
      occurred: '2026-10-01T10:00:00Z',
      body: 'About [[titration]]\nIn [[history]]',
    });

    const { nodes } = await buildGraph(vault);
    expect(nodes.find((node) => node.name === '2026-10-01-mentions-both')?.cluster).toBe('history');
  });

  it('places an episode at the moment it happened', async () => {
    const { nodes } = await buildGraph(vault);
    const episode = nodes.find((node) => node.name === '2026-09-02-moved');
    expect(episode?.at).toBe(Date.parse('2026-09-02T10:00:00Z'));
  });

  it('places an entity at the middle of its own history', async () => {
    /*
     * An entity has no time of its own -- an assignment is not an event. What
     * it has is the episodes that happened to it, so it sits at their centre.
     * Without this every entity piles up at one end and the cylinder becomes a
     * wall with a tail.
     */
    const { nodes } = await buildGraph(vault);
    const essay = nodes.find((node) => node.name === 'cold-war-essay');

    const early = Date.parse('2026-09-02T10:00:00Z');
    const late = Date.parse('2026-09-20T10:00:00Z');
    expect(essay?.at).toBe((early + late) / 2);
  });

  it('leaves an entity nothing ever happened to without a time', async () => {
    const { nodes } = await buildGraph(vault);
    expect(nodes.find((node) => node.name === 'titration')?.at).toBeNull();
  });

  it('returns the edges, pointing the way the links do', async () => {
    const { edges } = await buildGraph(vault);
    expect(edges).toContainEqual({ from: 'cold-war-essay', to: 'history' });
    expect(edges).toContainEqual({ from: '2026-09-02-moved', to: 'cold-war-essay' });
  });

  it('drops a link to a note that does not exist', async () => {
    // A dangling edge would draw a line to nowhere and count toward nothing.
    await vault.write({
      name: 'dangling',
      kind: 'episode',
      source: 'gmail',
      description: 'x',
      body: 'About [[never-written]]',
    });

    const { edges, nodes } = await buildGraph(vault);
    expect(edges.some((edge) => edge.to === 'never-written')).toBe(false);
    expect(nodes.some((node) => node.name === 'never-written')).toBe(false);
  });

  it('says how many of each kind there are, for a legend', async () => {
    const { nodes } = await buildGraph(vault);
    expect(nodes.filter((node) => node.kind === 'entity')).toHaveLength(5);
    expect(nodes.filter((node) => node.kind === 'episode')).toHaveLength(2);
  });
});
