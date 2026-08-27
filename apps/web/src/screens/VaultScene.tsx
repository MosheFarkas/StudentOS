import { useCallback, useMemo, useRef } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { CanvasTexture, Sprite, SpriteMaterial } from 'three';
import {
  colourFor,
  isDimmed,
  labelFor,
  labelled,
  litBy,
  sizeFor,
  FORCES,
  type DocEdge,
  type DocNode,
} from '../lib/vaultmap.js';

/**
 * The vault in three dimensions, and everything that needs WebGL to exist.
 *
 * Split from the panel around it so that this module -- most of a megabyte of
 * three.js and a physics engine -- is imported only when somebody actually
 * looks at their vault. A student on their way to the settings page should not
 * pay for a renderer they never open.
 *
 * The arrangement is the simulation's, not ours. A vault has no natural
 * coordinates: what a note is near is what it is linked to, and the only shape
 * that says so is the one the links settle into. Obsidian's graph does this for
 * the same reason, with the same three forces.
 */

/** What the simulation is handed. It writes positions onto these. */
type Sim = DocNode & { id: string; x?: number; y?: number; z?: number };

interface Props {
  nodes: DocNode[];
  edges: DocEdge[];
  held: string | null;
  hovered: string | null;
  onHold: (name: string) => void;
  onHover: (name: string | null) => void;
}

export default function VaultScene({ nodes, edges, held, hovered, onHold, onHover }: Props) {
  const engine = useRef<{
    cameraPosition: (p: unknown, look: unknown, ms: number) => void;
    d3Force: (
      name: string,
    ) => { distance?: (n: number) => void; strength?: (n: number) => void } | undefined;
  } | null>(null);

  /*
   * Built once, and never rebuilt on a hover.
   *
   * The simulation mutates what it is given -- positions, velocities -- so
   * handing it a fresh array on every render would restart the physics every
   * time the pointer moved, and the graph would never settle.
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

  /** Which end of a link is which, once the simulation has replaced ids with nodes. */
  const ends = (link: unknown): [string, string] => {
    const { source, target } = link as { source: Sim | string; target: Sim | string };
    return [
      typeof source === 'string' ? source : source.name,
      typeof target === 'string' ? target : target.name,
    ];
  };
  const touching = (link: unknown): boolean => {
    if (!lit) return false;
    const [a, b] = ends(link);
    return lit.name === a || lit.name === b;
  };

  /*
   * Fly to what was clicked.
   *
   * On a ball of four thousand, a click on the far side is otherwise a click
   * into fog: the thing lights up somewhere behind everything else and you have
   * to find it by hand.
   */
  const focus = useCallback(
    (node: unknown) => {
      const at = node as Sim;
      onHold(at.name);
      const { x = 0, y = 0, z = 0 } = at;
      const away = 1 + 150 / Math.max(1, Math.hypot(x, y, z));
      engine.current?.cameraPosition({ x: x * away, y: y * away, z: z * away }, at, 900);
    },
    [onHold],
  );

  /** The three forces, set once the engine exists. See FORCES. */
  const tune = useCallback((instance: unknown) => {
    engine.current = instance as never;
    if (!instance) return;
    const graph = instance as {
      d3Force: (n: string) => Record<string, (v: number) => void> | undefined;
    };
    graph.d3Force('charge')?.strength?.(FORCES.charge);
    graph.d3Force('link')?.distance?.(FORCES.linkDistance);
    graph.d3Force('link')?.strength?.(FORCES.linkStrength);
  }, []);

  return (
    <ForceGraph3D
      ref={tune as never}
      graphData={data as never}
      backgroundColor="#07091c"
      showNavInfo={false}
      /* Trackball: drag to turn it, wheel to come closer, right-drag to pan. */
      controlType="trackball"
      nodeId="id"
      nodeLabel={((node: Sim) => labelFor(node.name)) as never}
      nodeVal={((node: Sim) => sizeFor(node)) as never}
      nodeColor={
        ((node: Sim) => (isDimmed(node, lit) ? 'rgba(120,130,160,0.16)' : colourFor(node))) as never
      }
      nodeOpacity={0.92}
      nodeResolution={8}
      /*
       * Labels as sprites, so perspective does the work.
       *
       * A sprite lives in the scene, so it grows as you come closer and shrinks
       * as you pull back without anything computing that -- which is the whole
       * reason to read in here rather than in a list. Only the pages carry one
       * at rest: four thousand labels is a block of text with a graph behind it.
       */
      nodeThreeObjectExtend
      nodeThreeObject={
        ((node: Sim) =>
          labelled(node, held, hovered)
            ? label(labelFor(node.name), node.kind === 'document' ? 8 : 4.5)
            : undefined) as never
      }
      linkColor={
        ((link: unknown) =>
          touching(link)
            ? 'rgba(196,181,253,0.95)'
            : lit
              ? 'rgba(148,163,184,0.04)'
              : 'rgba(148,163,184,0.15)') as never
      }
      linkWidth={((link: unknown) => (touching(link) ? 1.4 : 0.3)) as never}
      linkOpacity={0.5}
      onNodeClick={focus as never}
      onNodeHover={((node: Sim | null) => onHover(node ? node.name : null)) as never}
      /*
       * Dragged and released, not pinned.
       *
       * The library re-heats the simulation while a node is held, so its
       * neighbours follow, and lets go on release so the whole thing settles
       * back. Pinning is the opt-in and would be the wrong choice: the
       * arrangement is meant to be the links' answer, not wherever somebody
       * happened to leave things.
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
 * Rendered at a large font and scaled down, rather than at its final size:
 * a sprite is resampled as you approach it, and one drawn small goes to mush
 * exactly when somebody has come close enough to want to read it.
 */
function label(text: string, height: number): Sprite | undefined {
  const canvas = document.createElement('canvas');
  const measuring = canvas.getContext('2d');
  if (!measuring) return undefined;

  const size = 64;
  measuring.font = `${size}px system-ui, sans-serif`;
  canvas.width = Math.ceil(measuring.measureText(text).width) + 16;
  canvas.height = Math.ceil(size * 1.4);

  // Resizing a canvas resets its context, so everything is set again after.
  const paint = canvas.getContext('2d');
  if (!paint) return undefined;
  paint.font = `${size}px system-ui, sans-serif`;
  paint.fillStyle = '#e8ecff';
  paint.textBaseline = 'middle';
  paint.fillText(text, 8, canvas.height / 2);

  const sprite = new Sprite(
    new SpriteMaterial({ map: new CanvasTexture(canvas), depthWrite: false, transparent: true }),
  );
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  sprite.position.set(0, height * 1.5, 0);
  return sprite;
}
