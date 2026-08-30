import { memo, useCallback, useMemo, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { forceCollide, forceRadial } from 'd3-force-3d';
import { CanvasTexture, Sprite, SpriteMaterial } from 'three';
import {
  colourFor,
  importantNames,
  labelFor,
  labelHeight,
  collideRadiusFor,
  labelled,
  linkDistanceFor,
  litBy,
  volumeFor,
  FORCES,
  NODE_REL_SIZE,
  type DocEdge,
  type DocNode,
} from '../lib/vaultmap.js';

/**
 * The vault in three dimensions, and everything that needs WebGL to exist.
 *
 * Split from the frame around it so that this module -- most of a megabyte of
 * three.js and a physics engine -- is fetched only when somebody actually
 * looks. A student on their way to their settings should not pay for a
 * renderer they never open.
 *
 * The arrangement is the simulation's, not ours. A vault has no natural
 * coordinates: what a note is near is what it links to, and the only shape that
 * says so is the one the links settle into. Obsidian's graph does this for the
 * same reason, with the same three forces -- repel, link, and a middle that
 * holds it together -- and a fourth here that Obsidian has no need of, because
 * it draws flat circles and this draws spheres that can swallow one another.
 */

/** What the simulation is handed. It writes positions onto these. */
type Sim = DocNode & { id: string; x?: number; y?: number; z?: number };

interface Engine {
  cameraPosition: (p?: unknown, look?: unknown, ms?: number) => { x: number; y: number; z: number };
  zoomToFit: (ms?: number, px?: number) => void;
  /** Getter with one argument, setter with two, as d3's own force accessor is. */
  d3Force: ((name: string) => Record<string, (v: number) => void> | undefined) &
    ((name: string, force: unknown) => void);
}

interface Props {
  nodes: DocNode[];
  edges: DocEdge[];
  held: string | null;
  width: number;
  height: number;
  onHold: (name: string) => void;
  onClear: () => void;
}

function VaultScene({ nodes, edges, held, width, height, onHold, onClear }: Props) {
  const engine = useRef<Engine | null>(null);

  /*
   * What the pointer is over, kept in here.
   *
   * Purely how the graph looks, so the frame around it -- which holds the page
   * being read -- has no reason to re-render when the pointer moves across
   * three thousand nodes.
   */
  const [hovered, setHovered] = useState<string | null>(null);

  /*
   * Built once, and never rebuilt on a hover.
   *
   * The simulation mutates what it is given -- positions, velocities -- so a
   * fresh array on every render would restart the physics every time the
   * pointer moved, and it would never settle.
   */
  const data = useMemo(() => {
    const exists = new Set(nodes.map((node) => node.name));
    return {
      nodes: nodes.map((node): Sim => ({ ...node, id: node.name })),
      links: edges
        .filter((edge) => exists.has(edge.from) && exists.has(edge.to))
        .map((edge) => ({ source: edge.from, target: edge.to })),
    };
  }, [nodes, edges]);

  const lit = useMemo(() => litBy(edges, hovered ?? held), [edges, hovered, held]);

  /** Which names are worth drawing. Decided once, from the graph itself. */
  const names = useMemo(() => importantNames(nodes), [nodes]);

  /*
   * The labels, built once and never rebuilt.
   *
   * This accessor's identity is what the renderer watches to decide whether
   * every node's 3d object needs making again. Written inline it was a new
   * function on every render, so a hover rebuilt three and a half thousand
   * sprites -- which is why clicking the dark flashed the names up and dropped
   * them. Held apart from the highlight, which changes colours and nothing else.
   */
  const labels = useCallback(
    (node: unknown) => {
      const at = node as Sim;
      return labelled(at, names, null) ? label(labelFor(at.name), labelHeight(at)) : undefined;
    },
    [names],
  );

  /*
   * The colours, held steady between clicks.
   *
   * The frame around this re-renders whenever a page finishes loading, so an
   * accessor written inline would be a new function each time and the renderer
   * would take that as a reason to go over every node again.
   */
  const paintNode = useCallback((node: unknown) => colourFor(node as Sim, lit), [lit]);

  /** Which end of a link is which, once the simulation has replaced ids with nodes. */
  const touching = useCallback(
    (link: unknown): boolean => {
      if (!lit) return false;
      const { source, target } = link as { source: Sim | string; target: Sim | string };
      const a = typeof source === 'string' ? source : source.name;
      const b = typeof target === 'string' ? target : target.name;
      return lit.name === a || lit.name === b;
    },
    [lit],
  );

  /*
   * A link is grey until one of its ends is held, and then it is the colour of
   * the thing holding it.
   *
   * Unheld links stay drawn rather than fading away: they are the shape of the
   * vault, and hiding them to make one note legible leaves a picture of a note
   * with nothing around it.
   */
  const paintLink = useCallback(
    (link: unknown) => (touching(link) ? '#a78bfa' : 'rgba(148,163,184,0.18)'),
    [touching],
  );

  const widthOf = useCallback((link: unknown) => (touching(link) ? 2.4 : 0.5), [touching]);

  /*
   * Fly to what was clicked.
   *
   * On a ball of three thousand, a click on the far side is otherwise a click
   * into fog: the thing lights up somewhere behind everything else and you have
   * to go and find it.
   *
   * A hundred and twenty units out along the same ray, which is about a
   * handful of notes across at the spacing the forces now settle into. It was
   * two hundred and twenty when they settled half again as far apart; a
   * distance measured in world units has to move when the world does, or
   * clicking a note stops framing the note and starts framing its district.
   */
  const focus = useCallback(
    (node: unknown) => {
      const at = node as Sim;
      onHold(at.name);
      const { x = 0, y = 0, z = 0 } = at;
      const away = 1 + 120 / Math.max(1, Math.hypot(x, y, z));
      engine.current?.cameraPosition({ x: x * away, y: y * away, z: z * away }, at, 900);
    },
    [onHold],
  );

  /** The forces, and a camera that starts with the whole thing in view. */
  const start = useCallback((instance: unknown) => {
    engine.current = instance as Engine | null;
    if (!instance) return;

    const graph = instance as Engine;
    graph.d3Force('charge')?.strength?.(FORCES.charge);

    /*
     * And the pull towards the middle, which the renderer does not have.
     *
     * What it registers as its centre is d3's own, which translates the whole
     * arrangement so its average sits on the origin and pulls on no node at
     * all. Repulsion therefore had nothing to settle against: the ball simply
     * grew for as long as the simulation ran, and the eight hundred notes
     * joined to nothing -- with no link to bring them back -- went furthest.
     *
     * Radius zero, so it is a pull home rather than towards a shell.
     */
    graph.d3Force('gravity', forceRadial(0).strength(FORCES.gravity));

    /*
     * How long a link wants to be, from what is on each end of it.
     *
     * The rule the whole arrangement rests on: a link between two big pages has
     * to be longer than one between two small notes. Asked for a flat distance,
     * the pull between the student and their school was shorter than the two of
     * them are wide, and the school settled inside the student.
     */
    graph
      .d3Force('link')
      ?.distance?.(((link: { source: DocNode; target: DocNode }) =>
        linkDistanceFor(link.source, link.target)) as never);
    graph.d3Force('link')?.strength?.(FORCES.linkStrength);

    /*
     * And the rule that is not a preference: nothing inside anything else.
     *
     * Its radius is derived from the same drawn size the link distance uses, so
     * the two forces ask for the same thing rather than pulling against each
     * other -- which is what leaves a node settled halfway into its neighbour,
     * whichever force happens to be stronger.
     */
    graph.d3Force(
      'collide',
      forceCollide((node: never) => collideRadiusFor(node as DocNode))
        .strength(FORCES.collideStrength)
        .iterations(FORCES.collideIterations) as never,
    );

    /*
     * Framed once the simulation has stopped thrashing.
     *
     * Fitting immediately frames a knot at the origin, because nothing has
     * moved yet -- which is how this came out looking like an empty box.
     */
    window.setTimeout(() => graph.zoomToFit(1200, 80), 2500);
  }, []);

  return (
    <ForceGraph3D
      ref={start as never}
      graphData={data as never}
      width={width}
      height={height}
      backgroundColor="#05071a"
      showNavInfo={false}
      /* Trackball: drag to turn it, wheel to come closer, right-drag to pan. */
      controlType="trackball"
      nodeId="id"
      nodeLabel={((node: Sim) => labelFor(node.name)) as never}
      /*
       * A volume in, and the radius the forces use back out.
       *
       * The renderer sizes a sphere as cbrt(val) * nodeRelSize. Left at its
       * default of four, every node was drawn four times the size collision was
       * keeping apart -- which is why the school sat inside the student while
       * collision reported itself satisfied.
       */
      nodeVal={((node: Sim) => volumeFor(node)) as never}
      nodeRelSize={NODE_REL_SIZE}
      nodeColor={paintNode as never}
      nodeOpacity={0.95}
      /*
       * Round enough to read as a sphere.
       *
       * Eight segments is an octagon spun round -- visibly faceted at any size
       * worth looking at. Sixteen is smooth to the eye and still cheap, which
       * matters when there are three thousand of them.
       */
      nodeResolution={16}
      /*
       * Names as sprites, so perspective does the resizing.
       *
       * A sprite lives in the scene, so coming closer grows it and pulling back
       * shrinks it without anything computing that -- which is the whole reason
       * to read in here rather than in a list.
       */
      nodeThreeObjectExtend
      nodeThreeObject={labels as never}
      linkColor={paintLink as never}
      linkWidth={widthOf as never}
      /* One, because the colours above already carry their own. */
      linkOpacity={1}
      onNodeClick={focus as never}
      onNodeHover={((node: Sim | null) => setHovered(node ? node.name : null)) as never}
      /* Clicking the dark is how you let go of something and see it all again. */
      onBackgroundClick={onClear}
      /*
       * Dragged and released, not pinned.
       *
       * The library re-heats the simulation while a node is held, so neighbours
       * follow, and lets go on release so everything settles back. Pinning is
       * the opt-in and would be the wrong answer: the arrangement is meant to be
       * the links', not wherever somebody left things.
       */
      enableNodeDrag
      cooldownTicks={400}
      d3AlphaDecay={0.012}
      d3VelocityDecay={0.34}
    />
  );
}

/**
 * A name, drawn into a texture and hung in the scene.
 *
 * Rendered at a large font and scaled down rather than drawn at its final size:
 * a sprite is resampled as you approach, and one drawn small goes to mush
 * exactly when somebody has come close enough to want to read it.
 */
function label(text: string, height: number): Sprite | undefined {
  const canvas = document.createElement('canvas');
  const measuring = canvas.getContext('2d');
  if (!measuring) return undefined;

  const size = 64;
  const font = `600 ${size}px system-ui, sans-serif`;
  measuring.font = font;
  canvas.width = Math.ceil(measuring.measureText(text).width) + 24;
  canvas.height = Math.ceil(size * 1.5);

  // Resizing a canvas resets its context, so everything is set again after.
  const paint = canvas.getContext('2d');
  if (!paint) return undefined;
  paint.font = font;
  paint.textBaseline = 'middle';

  /*
   * Drawn twice: a dark stroke under a light fill.
   *
   * A name over a bright cluster is unreadable without something behind it,
   * and a solid plate behind every name would hide the graph it is describing.
   */
  paint.lineWidth = 8;
  paint.strokeStyle = 'rgba(5,7,26,0.85)';
  paint.strokeText(text, 12, canvas.height / 2);
  paint.fillStyle = '#eef1ff';
  paint.fillText(text, 12, canvas.height / 2);

  const sprite = new Sprite(
    new SpriteMaterial({
      map: new CanvasTexture(canvas),
      transparent: true,
      /*
       * Drawn over everything, never behind it.
       *
       * A name is not a thing in the vault, it is a caption on one -- and a
       * caption that disappears because a note has drifted in front of it is
       * worse than no caption, because you cannot tell which. Depth testing off
       * takes it out of the queue that decides what is in front; the render
       * order puts it after the spheres so it lands on top of them.
       */
      depthTest: false,
      depthWrite: false,
    }),
  );
  sprite.renderOrder = 10;
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  sprite.position.set(0, height * 1.4, 0);
  return sprite;
}

/*
 * Held still while the frame around it changes.
 *
 * Opening a page is state in the parent, so without this every click would
 * re-render three and a half thousand nodes to show a paragraph of text.
 */
export default memo(VaultScene);
