import { describe, expect, it } from 'vitest';
import { absorptions, collapse, isNumbered } from './collapse.js';
import type { GraphNode, VaultGraph } from './graph.js';

/**
 * Folding the duplicates out of the picture.
 *
 * Two of them, and both are real on this account: a club drawn twice, once as
 * its Classroom room and once as the page describing it, and the student drawn
 * beside their own page because their school address turns up in their mail
 * like anybody else's.
 */

const node = (name: string, over: Partial<GraphNode> = {}): GraphNode => ({
  name,
  kind: 'entity',
  source: 'classroom',
  description: 'Assignment',
  degree: 0,
  at: null,
  cluster: null,
  ...over,
});

const page = (name: string) => node(name, { kind: 'document', source: 'agent', description: '' });
const course = (name: string) => node(name, { description: 'Course' });

describe('telling a thing that recurs from a thing that does not', () => {
  it('reads a year, however a school happens to write one', () => {
    for (const name of [
      '2025-2026-robotics',
      'grad-pride-2026-2027',
      'drama-10a-25-26',
      'le-parlement-des-jeunes-8-10-avril-2026',
    ]) {
      expect(isNumbered(name)).toBe(true);
    }
  });

  it('reads a grade, however a school happens to write one', () => {
    for (const name of ['grade-10-academic-advising', 'gr10-design', '10-phe', 'year-11-maths']) {
      expect(isNumbered(name)).toBe(true);
    }
  });

  it('reads a club with no number in it as the only one there will be', () => {
    for (const name of [
      'debating',
      'ss-model-un',
      'lions-den-business-club',
      'student-mentor-program',
    ]) {
      expect(isNumbered(name)).toBe(false);
    }
  });
});

describe('deciding what folds into what', () => {
  const graph = (over: Partial<VaultGraph> = {}): VaultGraph => ({
    nodes: [
      page('user'),
      page('class-debating'),
      page('class-robotics'),
      course('debating'),
      course('2025-2026-robotics'),
      node('lucas-liu', { description: 'Person' }),
    ],
    edges: [
      { from: 'user', to: 'class-debating' },
      { from: 'user', to: 'class-robotics' },
      { from: 'class-debating', to: 'debating' },
      { from: 'class-robotics', to: '2025-2026-robotics' },
    ],
    ...over,
  });

  it('folds a club with no year into the page describing it', () => {
    expect(absorptions(graph())).toContainEqual({ from: 'debating', into: 'class-debating' });
  });

  it('leaves a room named for its year alone', () => {
    /*
     * Robotics 2025-2026 is one of a series. The page is the subject and the
     * rooms under it are the years, so next year's room joins the page rather
     * than replacing this one.
     */
    expect(absorptions(graph()).map((a) => a.from)).not.toContain('2025-2026-robotics');
  });

  it('folds the student into the page about them, when they are told who that is', () => {
    expect(absorptions(graph(), 'lucas-liu')).toContainEqual({ from: 'lucas-liu', into: 'user' });
  });

  it('folds nobody in when it is not told who the student is', () => {
    expect(absorptions(graph()).map((a) => a.from)).not.toContain('lucas-liu');
  });

  it('folds no other person in, however many notes point at them', () => {
    // A teacher is a person in this vault and stays one.
    const withTeacher = graph({
      nodes: [...graph().nodes, node('mme-rivard', { description: 'Person' })],
    });
    expect(absorptions(withTeacher, 'lucas-liu').map((a) => a.from)).not.toContain('mme-rivard');
  });

  it('folds nothing into a page that does not exist', () => {
    const noPage = graph({ nodes: graph().nodes.filter((n) => n.name !== 'user') });
    expect(absorptions(noPage, 'lucas-liu').map((a) => a.from)).not.toContain('lucas-liu');
  });
});

describe('folding them in', () => {
  const graph: VaultGraph = {
    nodes: [
      page('user'),
      page('class-debating'),
      course('debating'),
      node('motion-notes', { cluster: 'debating' }),
      node('lucas-liu', { description: 'Person' }),
      node('an-essay'),
    ],
    edges: [
      { from: 'user', to: 'class-debating' },
      { from: 'class-debating', to: 'debating' },
      { from: 'motion-notes', to: 'debating' },
      { from: 'an-essay', to: 'lucas-liu' },
    ],
  };

  const folded = collapse(graph, [
    { from: 'debating', into: 'class-debating' },
    { from: 'lucas-liu', into: 'user' },
  ]);

  it('takes the folded nodes out of the picture', () => {
    expect(folded.nodes.map((n) => n.name)).not.toContain('debating');
    expect(folded.nodes.map((n) => n.name)).not.toContain('lucas-liu');
  });

  it('moves what pointed at them onto their host', () => {
    /*
     * The reason the folded node was worth drawing at all. A club's whole
     * subtree hangs off its room, and dropping the room without moving its
     * links would leave that subtree floating unattached beside its page.
     */
    expect(folded.edges).toContainEqual({ from: 'motion-notes', to: 'class-debating' });
    expect(folded.edges).toContainEqual({ from: 'an-essay', to: 'user' });
  });

  it('drops the link that became a loop', () => {
    // The page pointed at its own room. Folded, that is a node pointing at
    // itself, which is a dot with a circle on it and means nothing.
    expect(folded.edges).not.toContainEqual({ from: 'class-debating', to: 'class-debating' });
  });

  it('keeps everything else exactly as it was', () => {
    expect(folded.edges).toContainEqual({ from: 'user', to: 'class-debating' });
    expect(folded.nodes.map((n) => n.name)).toContain('an-essay');
  });

  it('refiles what was clustered under a folded room', () => {
    expect(folded.nodes.find((n) => n.name === 'motion-notes')?.cluster).toBe('class-debating');
  });

  it('counts the host as being pointed at by what it inherited', () => {
    // The page is drawn by how much of the vault points at it, and it has just
    // taken on everything that pointed at the room.
    expect(folded.nodes.find((n) => n.name === 'class-debating')?.degree).toBe(2);
  });

  it('never draws the same link twice', () => {
    // Two notes on the room and the page both fold to one pair of endpoints.
    const twice = collapse(
      {
        nodes: [page('class-debating'), course('debating'), node('a')],
        edges: [
          { from: 'a', to: 'debating' },
          { from: 'a', to: 'class-debating' },
        ],
      },
      [{ from: 'debating', into: 'class-debating' }],
    );

    expect(twice.edges).toHaveLength(1);
  });

  it('leaves a graph alone when nothing folds', () => {
    expect(collapse(graph, [])).toBe(graph);
  });
});
