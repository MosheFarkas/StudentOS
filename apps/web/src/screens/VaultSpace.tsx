import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  layout,
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
 * The point is not that it looks like something. It is that a student can turn
 * it and see that their busiest subject is a dense rope down the middle and the
 * week before an exam is a bulge, without anybody explaining it to them.
 */

interface Props {
  agentId: string;
}

const COLOURS: Record<string, string> = {
  Course: '#5010d0',
  Assignment: '#4070ff',
  Topic: '#2f9bbc',
  Person: '#c090ff',
};

/** Episodes are what happened; they read as marks rather than things. */
const EPISODE = '#6b7194';

function colourFor(node: GraphNode): string {
  if (node.kind === 'episode') return node.source === 'student' ? '#12805c' : EPISODE;
  return COLOURS[node.description] ?? '#8a8fae';
}

export function VaultSpace({ agentId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref rather than state: dragging repaints every frame, and React
  // does not need to re-render for a camera that moved two degrees.
  const camera = useRef<Camera>({ spin: 0.5, tilt: 0.35, zoom: 1 });
  const projected = useRef<Projected[]>([]);
  const drag = useRef<{ x: number; y: number } | null>(null);

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
      canvas.width = width * ratio;
      canvas.height = height * ratio;

      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const points = project(placed, camera.current, width, height);
      projected.current = points;
      const screen = new Map(points.map((point) => [point.placed.node.name, point]));

      /*
       * Edges first and very faint.
       *
       * There are more links than nodes, and drawn at any real strength they
       * become a grey fog with the structure hidden inside it. They are here to
       * suggest the threads, not to be read individually.
       */
      context.lineWidth = 0.5;
      context.strokeStyle = 'rgba(107, 113, 148, 0.16)';
      context.beginPath();
      for (const edge of graph.edges) {
        const from = screen.get(edge.from);
        const to = screen.get(edge.to);
        if (!from || !to) continue;
        context.moveTo(from.screenX, from.screenY);
        context.lineTo(to.screenX, to.screenY);
      }
      context.stroke();

      // Then nodes, far to near, so the shape reads the right way round.
      for (const point of points) {
        const node = point.placed.node;
        // Further away is fainter, which is what makes it read as depth at all.
        const fade = Math.max(0.25, Math.min(1, 6 / point.depth - 0.35));
        context.globalAlpha = hovered && hovered.name === node.name ? 1 : fade;
        context.fillStyle = colourFor(node);
        context.beginPath();
        context.arc(point.screenX, point.screenY, Math.max(1, point.size), 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [graph, hovered]);

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (drag.current) {
      camera.current.spin += (x - drag.current.x) * 0.01;
      // Stopped short of straight down the axis, where the cylinder becomes a
      // disc and there is nothing to see.
      camera.current.tilt = Math.max(
        -1.2,
        Math.min(1.2, camera.current.tilt + (y - drag.current.y) * 0.01),
      );
      drag.current = { x, y };
      return;
    }

    setHovered(pick(projected.current, x, y)?.placed.node ?? null);
  }

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
    <>
      <canvas
        ref={canvasRef}
        className="vault-space"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          drag.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
        }}
        onPointerLeave={() => {
          drag.current = null;
          setHovered(null);
        }}
        onPointerMove={onPointerMove}
        onWheel={(event) => {
          camera.current.zoom = Math.max(
            0.5,
            Math.min(3, camera.current.zoom - event.deltaY * 0.001),
          );
        }}
      />

      <p className="muted">
        {hovered
          ? `${hovered.name.replaceAll('-', ' ')} — ${hovered.description}${
              hovered.degree > 0 ? `, ${hovered.degree} things point at it` : ''
            }`
          : 'Drag to turn it, scroll to zoom. Along is time, toward the middle is how much everything else depends on it, and around is which subject.'}
      </p>
    </>
  );
}
