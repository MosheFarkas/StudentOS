import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { CanvasTexture, Sprite, SpriteMaterial } from 'three';
import {
  colourFor,
  isDimmed,
  labelFor,
  labelHeight,
  labelled,
  litBy,
  nearest,
  sizeFor,
  FORCES,
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
 * same reason, with the same three forces.
 */

/** What the simulation is handed. It writes positions onto these. */
type Sim = DocNode & { id: string; x?: number; y?: number; z?: number };

interface Engine {
  cameraPosition: (p?: unknown, look?: unknown, ms?: number) => { x: number; y: number; z: number };
  zoomToFit: (ms?: number, px?: number) => void;
  d3Force: (name: string) => Record<string, (v: number) => void> | undefined;
}

interface Props {
  nodes: DocNode[];
  edges: DocEdge[];
  held: string | null;
  hovered: string | null;
  width: number;
  height: number;
  onHold: (name: string) => void;
  onHover: (name: string | null) => void;
  onClear: () => void;
}

/**
 * How close the camera has to be for a note to say what it is.
 *
 * Roughly a dozen link-lengths: near enough that what is named is what you are
 * looking at, far enough that flying toward a cluster names it before you
 * arrive rather than as you pass through.
 */
const READING_RANGE = FORCES.linkDistance * 12;

export default function VaultScene({
  nodes,
  edges,
  held,
  hovered,
  width,
  height,
  onHold,
  onHover,
  onClear,
}: Props) {
  const engine = useRef<Engine | null>(null);
  const [near, setNear] = useState<ReadonlySet<string>>(new Set());

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

  /*
   * What the camera is close enough to read, checked a few times a second.
   *
   * Polled rather than driven by an event: the library exposes no camera-moved
   * hook, and a poll at this rate costs one pass over the nodes while somebody
   * is flying and nothing at all while they are not. The set is replaced only
   * when it actually changes, because replacing it rebuilds every label.
   */
  useEffect(() => {
    const tick = window.setInterval(() => {
      const where = engine.current?.cameraPosition();
      if (!where) return;

      const found = nearest(data.nodes, where, READING_RANGE);
      setNear((was) => {
        if (was.size === found.size && [...found].every((name) => was.has(name))) return was;
        return found;
      });
    }, 400);

    return () => window.clearInterval(tick);
  }, [data]);

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
   * Fly to what was clicked.
   *
   * On a ball of three thousand, a click on the far side is otherwise a click
   * into fog: the thing lights up somewhere behind everything else and you have
   * to go and find it.
   */
  const focus = useCallback(
    (node: unknown) => {
      const at = node as Sim;
      onHold(at.name);
      const { x = 0, y = 0, z = 0 } = at;
      const away = 1 + 220 / Math.max(1, Math.hypot(x, y, z));
      engine.current?.cameraPosition({ x: x * away, y: y * away, z: z * away }, at, 900);
    },
    [onHold],
  );

  /** The three forces, and a camera that starts with the whole thing in view. */
  const start = useCallback((instance: unknown) => {
    engine.current = instance as Engine | null;
    if (!instance) return;

    const graph = instance as Engine;
    graph.d3Force('charge')?.strength?.(FORCES.charge);
    graph.d3Force('link')?.distance?.(FORCES.linkDistance);
    graph.d3Force('link')?.strength?.(FORCES.linkStrength);

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
      nodeRelSize={1}
      nodeLabel={((node: Sim) => labelFor(node.name)) as never}
      nodeVal={((node: Sim) => sizeFor(node)) as never}
      nodeColor={
        ((node: Sim) => (isDimmed(node, lit) ? 'rgba(120,130,160,0.14)' : colourFor(node))) as never
      }
      nodeOpacity={0.95}
      nodeResolution={8}
      /*
       * Names as sprites, so perspective does the resizing.
       *
       * A sprite lives in the scene, so coming closer grows it and pulling back
       * shrinks it without anything computing that -- which is the whole reason
       * to read in here rather than in a list.
       */
      nodeThreeObjectExtend
      nodeThreeObject={
        ((node: Sim) =>
          labelled(node, near, held, hovered)
            ? label(labelFor(node.name), labelHeight(node), isDimmed(node, lit))
            : undefined) as never
      }
      linkColor={
        ((link: unknown) =>
          touching(link)
            ? 'rgba(216,205,255,0.95)'
            : lit
              ? 'rgba(148,163,184,0.05)'
              : 'rgba(148,163,184,0.22)') as never
      }
      linkWidth={((link: unknown) => (touching(link) ? 1.6 : 0.4)) as never}
      linkOpacity={0.6}
      onNodeClick={focus as never}
      onNodeHover={((node: Sim | null) => onHover(node ? node.name : null)) as never}
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
function label(text: string, height: number, dimmed: boolean): Sprite | undefined {
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
  paint.fillStyle = dimmed ? 'rgba(200,208,232,0.28)' : '#eef1ff';
  paint.fillText(text, 12, canvas.height / 2);

  const sprite = new Sprite(
    new SpriteMaterial({ map: new CanvasTexture(canvas), depthWrite: false, transparent: true }),
  );
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  sprite.position.set(0, height * 1.4, 0);
  return sprite;
}
