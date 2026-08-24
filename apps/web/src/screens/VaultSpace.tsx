import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  layout,
  neighbours,
  pick,
  project,
  type Camera,
  type GraphEdge,
  type GraphNode,
  type Projected,
} from '../lib/cylinder.js';

/**
 * The vault, as a shape you can turn.
 *
 * Not an illustration of the graph -- the graph itself, with each axis carrying
 * something true. Time runs along the cylinder, how-many-notes-point-at-it
 * pulls a thing toward the core, and which course it belongs to decides its
 * bearing, so every subject is a thread running the length of the year.
 *
 * Dark on purpose, inside an otherwise light app. A thousand small bright
 * points need a ground to be bright against, and the same dots on white read
 * as dust rather than as a structure. This is a window onto something, the way
 * a map is, not another panel.
 */

interface Props {
  agentId: string;
}

/** Brighter than the app's own palette, because these sit on near-black. */
const COLOURS: Record<string, string> = {
  Course: '#a78bfa',
  Assignment: '#60a5fa',
  Topic: '#22d3ee',
  Person: '#f0abfc',
  Material: '#fbbf24',
};

function colourFor(node: GraphNode): string {
  if (node.kind === 'episode') {
    // What the student said themselves is the one thing here they wrote.
    if (node.source === 'student') return '#34d399';
    return node.source === 'classroom' ? '#94a3b8' : '#7c8bb0';
  }
  return COLOURS[node.description] ?? '#8a8fae';
}

/** Labels are only legible up to a point; past it they are texture. */
const MAX_LABELS = 26;

interface Held {
  body: string;
  sourceUrl: string | null;
}

/**
 * A note body, with its [[wikilinks]] turned into somewhere to go.
 *
 * The links are the whole structure of the vault, and rendered as raw brackets
 * they are punctuation the student has to ignore. Made clickable they are the
 * shortest path from "what did my teacher say" to the assignment it was about.
 */
function withLinks(body: string, go: (name: string) => void) {
  return body.split(/(\[\[[^\]]+\]\])/g).map((piece, index) => {
    const link = /^\[\[([^\]]+)\]\]$/.exec(piece);
    if (!link) return <span key={index}>{piece}</span>;
    const name = link[1] as string;
    return (
      <button key={index} type="button" className="vault-space-inline" onClick={() => go(name)}>
        {name.replaceAll('-', ' ')}
      </button>
    );
  });
}

export function VaultSpace({ agentId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [held, setHeld] = useState<Held | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * The camera is two cameras: where it is, and where it is going.
   *
   * Every frame the first eases toward the second, which is what turns a
   * scroll notch into a glide and lets a click recentre the view instead of
   * teleporting it. Both live in refs -- dragging repaints sixty times a
   * second and React does not need to re-render for an angle that moved two
   * degrees.
   */
  const camera = useRef<Camera>({ spin: 0.5, tilt: 0.35, zoom: 1 });
  const target = useRef<Camera>({ spin: 0.5, tilt: 0.35, zoom: 1 });
  const projected = useRef<Projected[]>([]);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const idle = useRef(0);

  useEffect(() => {
    void (async () => {
      const res = await api.agents[':id'].vault.graph.$get({ param: { id: agentId } });
      if (!res.ok) {
        setError('That could not be loaded.');
        return;
      }
      setGraph(await res.json());
    })();
  }, [agentId]);

  /*
   * The note itself, once something is actually held.
   *
   * Only on a click, never on a hover: moving the pointer across a thousand
   * nodes would be a thousand requests. Seeing that an announcement exists is
   * worth much less than reading what the teacher wrote in it.
   */
  useEffect(() => {
    if (!focused) {
      setHeld(null);
      return;
    }
    let dropped = false;
    void (async () => {
      const res = await api.agents[':id'].vault[':name'].$get({
        param: { id: agentId, name: focused },
      });
      // A click that lands while an older request is in flight must win, or
      // the panel fills in with whatever the student stopped caring about.
      if (!res.ok || dropped) return;
      const data = await res.json();
      setHeld({ body: data.note.body, sourceUrl: data.note.sourceUrl });
    })();
    return () => {
      dropped = true;
    };
  }, [agentId, focused]);

  /*
   * What is lit.
   *
   * A search lights every match. Otherwise it is whatever is held or hovered,
   * plus everything one link away from it -- which is the whole point of
   * holding something: an assignment on its own is a dot, and an assignment
   * with its course, its unit and the six emails about it is a story.
   */
  const lit = useMemo(() => {
    if (!graph) return null;

    const search = query.trim().toLowerCase();
    if (search.length > 0) {
      const matches = graph.nodes
        .filter((node) => node.name.includes(search.replaceAll(' ', '-')))
        .map((node) => node.name);
      return new Set(matches);
    }

    const centre = focused ?? hovered;
    if (!centre) return null;
    return new Set([centre, ...neighbours(graph.edges, centre)]);
  }, [graph, query, focused, hovered]);

  // Read by the draw loop, which must not restart every time a pointer moves.
  const view = useRef<{ lit: Set<string> | null; centre: string | null }>({
    lit: null,
    centre: null,
  });
  view.current = { lit, centre: focused ?? hovered };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph) return;

    // Laid out once. The camera moves; the cylinder does not.
    const placed = layout(graph.nodes);
    let frame = 0;

    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
      }

      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      /*
       * A slow drift when nobody is touching it.
       *
       * A still cylinder from one angle is a smear of dots; the depth only
       * reads once it moves. Stopped the moment anything is held, because
       * trying to read a label on something rotating away is maddening.
       */
      idle.current += 1;
      if (!drag.current && !view.current.centre && idle.current > 90) {
        target.current.spin += 0.0016;
      }

      for (const key of ['spin', 'tilt', 'zoom'] as const) {
        camera.current[key] += (target.current[key] - camera.current[key]) * 0.12;
      }

      const ground = context.createRadialGradient(
        width / 2,
        height / 2,
        0,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.7,
      );
      ground.addColorStop(0, '#141a3d');
      ground.addColorStop(1, '#07091c');
      context.fillStyle = ground;
      context.fillRect(0, 0, width, height);

      const points = project(placed, camera.current, width, height);
      projected.current = points;
      const screen = new Map(points.map((point) => [point.placed.node.name, point]));
      const { lit: onlyThese, centre } = view.current;

      /*
       * Edges first, and in two passes.
       *
       * There are more links than nodes, and drawn at any real strength they
       * are a grey fog with the structure hidden inside it -- so normally they
       * only suggest the threads. When something is held, the handful of links
       * that touch it are drawn over the top at full strength, and that
       * contrast is the entire answer to "what is this connected to".
       */
      context.lineWidth = 0.5;
      context.strokeStyle = onlyThese ? 'rgba(120, 132, 190, 0.05)' : 'rgba(130, 142, 200, 0.13)';
      context.beginPath();
      for (const edge of graph.edges) {
        const from = screen.get(edge.from);
        const to = screen.get(edge.to);
        if (!from || !to) continue;
        if (onlyThese && centre && (edge.from === centre || edge.to === centre)) continue;
        context.moveTo(from.screenX, from.screenY);
        context.lineTo(to.screenX, to.screenY);
      }
      context.stroke();

      if (onlyThese && centre) {
        context.lineWidth = 1.2;
        context.strokeStyle = 'rgba(167, 139, 250, 0.75)';
        context.beginPath();
        for (const edge of graph.edges) {
          if (edge.from !== centre && edge.to !== centre) continue;
          const from = screen.get(edge.from);
          const to = screen.get(edge.to);
          if (!from || !to) continue;
          context.moveTo(from.screenX, from.screenY);
          context.lineTo(to.screenX, to.screenY);
        }
        context.stroke();
      }

      /*
       * The dimmed remainder, in a single pass.
       *
       * When something is held, well over a thousand nodes are drawn at seven
       * percent opacity, where hue is imperceptible -- so they go into one
       * path and one fill instead of a beginPath and a fill each. This is the
       * frame the student is looking at while they drag, which is exactly the
       * frame that must not stutter.
       */
      if (onlyThese) {
        context.globalAlpha = 0.07;
        context.fillStyle = '#8a8fae';
        context.beginPath();
        for (const point of points) {
          if (onlyThese.has(point.placed.node.name)) continue;
          const radius = Math.max(1, point.size);
          context.moveTo(point.screenX + radius, point.screenY);
          context.arc(point.screenX, point.screenY, radius, 0, Math.PI * 2);
        }
        context.fill();
      }

      // Then nodes, far to near, so the shape reads the right way round.
      for (const point of points) {
        const node = point.placed.node;
        const isLit = !onlyThese || onlyThese.has(node.name);
        if (onlyThese && !isLit) continue;
        // Further away is fainter, which is what makes it read as depth at all.
        const fade = Math.max(0.3, Math.min(1, 6 / point.depth - 0.3));

        context.globalAlpha = onlyThese ? 1 : fade;
        context.fillStyle = colourFor(node);

        /*
         * Glow only on what is lit. shadowBlur is the most expensive thing on
         * a 2D canvas, and asking for it on a thousand nodes every frame drops
         * the whole thing to single figures.
         */
        if (isLit && onlyThese) {
          context.shadowBlur = node.name === centre ? 22 : 11;
          context.shadowColor = colourFor(node);
        }

        context.beginPath();
        context.arc(
          point.screenX,
          point.screenY,
          Math.max(1, point.size * (node.name === centre ? 1.7 : 1)),
          0,
          Math.PI * 2,
        );
        context.fill();
        context.shadowBlur = 0;
      }
      context.globalAlpha = 1;

      /*
       * Names, for the lit few.
       *
       * Only ever drawn for what is held or matched, and only the busiest of
       * those: a thousand labels is a solid block of text, and the point of
       * lighting something up is to be able to read it.
       */
      if (onlyThese) {
        const labelled = points
          .filter((point) => onlyThese.has(point.placed.node.name))
          .sort((a, b) => b.placed.node.degree - a.placed.node.degree)
          .slice(0, MAX_LABELS);

        context.font = '11px ui-sans-serif, system-ui, sans-serif';
        context.textBaseline = 'middle';
        for (const point of labelled) {
          const node = point.placed.node;
          const text = node.name.replaceAll('-', ' ');
          const x = point.screenX + point.size + 6;
          const y = point.screenY;

          const width_ = context.measureText(text).width;
          context.fillStyle = 'rgba(7, 9, 28, 0.72)';
          context.fillRect(x - 3, y - 8, width_ + 6, 16);
          context.fillStyle = node.name === centre ? '#ffffff' : '#c7cbe4';
          context.fillText(text, x, y);
        }
      }

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [graph]);

  function at(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y } = at(event);
    idle.current = 0;

    if (drag.current) {
      target.current.spin += (x - drag.current.x) * 0.01;
      // Stopped short of straight down the axis, where the cylinder becomes a
      // disc and there is nothing to see.
      target.current.tilt = Math.max(
        -1.2,
        Math.min(1.2, target.current.tilt + (y - drag.current.y) * 0.01),
      );
      drag.current = { x, y };
      return;
    }

    setHovered(pick(projected.current, x, y)?.placed.node.name ?? null);
  }

  const node = graph?.nodes.find((candidate) => candidate.name === (focused ?? hovered));
  const linked = graph && node ? [...neighbours(graph.edges, node.name)] : [];

  if (error) return <p className="muted">{error}</p>;
  if (!graph) return <p className="muted">Loading…</p>;
  if (graph.nodes.length === 0) {
    return (
      <p className="muted">
        Nothing to show yet. This fills in once you connect Google and it has read your Classroom.
      </p>
    );
  }

  return (
    <div className="vault-space-wrap">
      <div className="vault-space-bar">
        <input
          className="vault-space-find"
          type="search"
          value={query}
          placeholder={`Find something among ${graph.nodes.length}…`}
          onChange={(event) => setQuery(event.target.value)}
        />
        {focused ? (
          <button type="button" className="ghost" onClick={() => setFocused(null)}>
            Let go
          </button>
        ) : null}
      </div>

      <canvas
        ref={canvasRef}
        className="vault-space"
        onPointerDown={(event) => {
          const { x, y } = at(event);
          idle.current = 0;
          /*
           * Landing on something holds it; landing on nothing turns the whole
           * cylinder. One gesture, and which one it is depends on what is
           * under the finger -- so nothing has to be explained.
           */
          const hit = pick(projected.current, x, y);
          if (hit) {
            setFocused(hit.placed.node.name);
            return;
          }
          setFocused(null);
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x, y };
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          drag.current = null;
        }}
        onPointerLeave={() => {
          drag.current = null;
          setHovered(null);
        }}
        onPointerMove={onPointerMove}
        onWheel={(event) => {
          idle.current = 0;
          target.current.zoom = Math.max(
            0.4,
            Math.min(6, target.current.zoom - event.deltaY * 0.0015),
          );
        }}
      />

      {node ? (
        <div className="vault-space-card">
          <strong>{node.name.replaceAll('-', ' ')}</strong>
          <span className="muted">
            {node.description}
            {node.degree > 0 ? ` · ${node.degree} things point at it` : ''}
            {node.cluster && node.cluster !== node.name
              ? ` · ${node.cluster.replaceAll('-', ' ')}`
              : ''}
          </span>
          {focused && held ? (
            <p className="vault-space-body">{withLinks(held.body, setFocused)}</p>
          ) : null}
          {focused && held?.sourceUrl ? (
            <a href={held.sourceUrl} target="_blank" rel="noreferrer" className="vault-space-open">
              See it where it came from
            </a>
          ) : null}
          {linked.length > 0 ? (
            <p className="vault-space-links">
              {/* Clicking one moves the light onto it, which is how you walk
                  the vault rather than just look at it. */}
              {linked.slice(0, 12).map((name) => (
                <button key={name} type="button" onClick={() => setFocused(name)}>
                  {name.replaceAll('-', ' ')}
                </button>
              ))}
              {linked.length > 12 ? (
                <span className="muted">and {linked.length - 12} more</span>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="muted">
          Drag to turn it, scroll to zoom, and hold anything to light up what it is connected to.
          Along is time, toward the middle is how much everything else depends on it, and around is
          which subject.
        </p>
      )}
    </div>
  );
}
