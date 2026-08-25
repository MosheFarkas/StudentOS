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

/*
 * No props.
 *
 * This used to take an agent id, because the vault used to belong to an agent.
 * It belongs to the student now, and the gate meant that deleting your agents
 * hid your own school from you -- the notes were all still there.
 */

/** Brighter than the app's own palette, because these sit on near-black. */
const COLOURS: Record<string, string> = {
  Course: '#a78bfa',
  Assignment: '#60a5fa',
  Topic: '#22d3ee',
  Person: '#f0abfc',
  Material: '#fbbf24',
};

/*
 * Files are the largest thing in the vault and they are not all alike.
 *
 * One a teacher attached in Classroom and one out of the student's own Drive
 * are different objects: the first is what they were given, the second is what
 * they made. Falling through to the same grey as everything unrecognised
 * turned eleven hundred nodes -- the biggest group there is -- into fog.
 */
const OWN_FILE = '#a3e635';
const GIVEN_FILE = '#fb923c';

function colourFor(node: GraphNode): string {
  if (node.kind === 'episode') {
    // What the student said themselves is the one thing here they wrote.
    if (node.source === 'student') return '#34d399';
    return node.source === 'classroom' ? '#94a3b8' : '#7c8bb0';
  }
  if (node.description === 'File') return node.source === 'drive' ? OWN_FILE : GIVEN_FILE;
  return COLOURS[node.description] ?? '#8a8fae';
}

/** Labels are only legible up to a point; past it they are texture. */
const MAX_LABELS = 26;

/*
 * What the colours mean.
 *
 * Without this it is six colours of dot and no way to know which is which, and
 * a picture nobody can read is decoration however true its geometry is.
 */
const KEY: { colour: string; label: string }[] = [
  { colour: COLOURS.Course as string, label: 'Courses' },
  { colour: COLOURS.Assignment as string, label: 'Work' },
  { colour: COLOURS.Topic as string, label: 'Units' },
  { colour: COLOURS.Material as string, label: 'Readings' },
  { colour: GIVEN_FILE, label: 'Files from class' },
  { colour: OWN_FILE, label: 'Your own files' },
  { colour: COLOURS.Person as string, label: 'People' },
  { colour: '#94a3b8', label: 'Things that happened' },
  { colour: '#34d399', label: 'What you told it' },
];

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

export function VaultSpace() {
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
      const res = await api.vault.graph.$get();
      if (!res.ok) {
        setError('That could not be loaded.');
        return;
      }
      setGraph(await res.json());
    })();
  }, []);

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
      const res = await api.vault.note[':name'].$get({ param: { name: focused } });
      // A click that lands while an older request is in flight must win, or
      // the panel fills in with whatever the student stopped caring about.
      if (!res.ok || dropped) return;
      const data = await res.json();
      setHeld({ body: data.note.body, sourceUrl: data.note.sourceUrl });
    })();
    return () => {
      dropped = true;
    };
  }, [focused]);

  /*
   * What is lit.
   *
   * A search lights every match. Otherwise it is whatever is held, plus
   * everything one link away from it -- which is the whole point of holding
   * something: an assignment on its own is a dot, and an assignment with its
   * course, its unit and the six emails about it is a story.
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

    /*
     * Holding, not hovering.
     *
     * Hover used to light the whole neighbourhood too, which meant dragging
     * the pointer across a thousand nodes strobed the entire picture. Hover
     * now only names what is under the pointer; lighting up is something you
     * ask for.
     */
    if (!focused) return null;
    return new Set([focused, ...neighbours(graph.edges, focused)]);
  }, [graph, query, focused]);

  // Read by the draw loop, which must not restart every time a pointer moves.
  const view = useRef<{ lit: Set<string> | null; centre: string | null; named: string | null }>({
    lit: null,
    centre: null,
    named: null,
  });
  view.current = { lit, centre: focused, named: hovered };

  /*
   * How far into the lit state the picture is, 0 to 1.
   *
   * Eased rather than switched, so letting go fades the vault back up instead
   * of snapping. It is also what stops a hover-then-click from flashing.
   */
  const emphasis = useRef(0);

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
      const { lit: onlyThese, centre, named } = view.current;

      emphasis.current += ((onlyThese ? 1 : 0) - emphasis.current) * 0.14;
      const held = emphasis.current;
      // Below this the fade is finished and the two paths would draw the same
      // thing, so the cheaper one wins.
      const lighting = held > 0.01 && onlyThese !== null;

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
      context.strokeStyle = `rgba(130, 142, 200, ${0.13 - held * 0.08})`;
      context.beginPath();
      for (const edge of graph.edges) {
        const from = screen.get(edge.from);
        const to = screen.get(edge.to);
        if (!from || !to) continue;
        if (lighting && centre && (edge.from === centre || edge.to === centre)) continue;
        context.moveTo(from.screenX, from.screenY);
        context.lineTo(to.screenX, to.screenY);
      }
      context.stroke();

      /*
       * Every link that touches what is held, drawn over the top.
       *
       * Coloured from the thing at the far end rather than one flat accent, so
       * a held course shows at a glance that its work is blue, its units are
       * cyan and the people who mailed about it are pink. One stroke each,
       * which is a few dozen even on the busiest node in the vault.
       */
      if (lighting && centre) {
        const anchor = screen.get(centre);
        context.lineWidth = 1.4;
        context.globalAlpha = held;
        for (const edge of graph.edges) {
          const otherEnd = edge.from === centre ? edge.to : edge.to === centre ? edge.from : null;
          if (otherEnd === null || !anchor) continue;
          const other = screen.get(otherEnd);
          if (!other) continue;

          context.strokeStyle = colourFor(other.placed.node);
          context.beginPath();
          context.moveTo(anchor.screenX, anchor.screenY);
          context.lineTo(other.screenX, other.screenY);
          context.stroke();
        }
        context.globalAlpha = 1;
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
      if (lighting) {
        // Eased with the rest, so letting go fades the vault back up.
        context.globalAlpha = 0.07 + (1 - held) * 0.5;
        context.fillStyle = '#8a8fae';
        context.beginPath();
        for (const point of points) {
          if (onlyThese?.has(point.placed.node.name)) continue;
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
        if (lighting && !isLit) continue;
        // Further away is fainter, which is what makes it read as depth at all.
        const fade = Math.max(0.3, Math.min(1, 6 / point.depth - 0.3));

        context.globalAlpha = fade + (1 - fade) * (isLit ? held : 0);
        context.fillStyle = colourFor(node);

        /*
         * Glow only on what is lit. shadowBlur is the most expensive thing on
         * a 2D canvas, and asking for it on a thousand nodes every frame drops
         * the whole thing to single figures.
         */
        if (isLit && lighting) {
          context.shadowBlur = (node.name === centre ? 22 : 11) * held;
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
      /*
       * A ring around what the pointer is over, when nothing is held.
       *
       * Hover no longer lights the neighbourhood, so it needs some other way
       * to say "this is the one you would be holding".
       */
      if (!lighting && named) {
        const point = screen.get(named);
        if (point) {
          context.strokeStyle = '#ffffff';
          context.lineWidth = 1.5;
          context.beginPath();
          context.arc(point.screenX, point.screenY, Math.max(4, point.size + 4), 0, Math.PI * 2);
          context.stroke();
        }
      }

      if (lighting && onlyThese) {
        const labelled = points
          .filter((point) => onlyThese.has(point.placed.node.name))
          .sort((a, b) => b.placed.node.degree - a.placed.node.degree)
          .slice(0, MAX_LABELS);

        context.font = '11px ui-sans-serif, system-ui, sans-serif';
        context.textBaseline = 'middle';
        context.globalAlpha = held;
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
        context.globalAlpha = 1;
      } else if (named) {
        // Just the one name, for whatever is under the pointer.
        const point = screen.get(named);
        if (point) {
          const text = named.replaceAll('-', ' ');
          context.font = '11px ui-sans-serif, system-ui, sans-serif';
          context.textBaseline = 'middle';
          const x = point.screenX + point.size + 6;
          context.fillStyle = 'rgba(7, 9, 28, 0.72)';
          context.fillRect(x - 3, point.screenY - 8, context.measureText(text).width + 6, 16);
          context.fillStyle = '#ffffff';
          context.fillText(text, x, point.screenY);
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
        <button
          type="button"
          className="ghost"
          onClick={() => {
            target.current = { spin: 0.5, tilt: 0.35, zoom: 1 };
            setFocused(null);
            setQuery('');
          }}
        >
          Reset
        </button>
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

      <div className="vault-space-key">
        {KEY.map((entry) => (
          <span key={entry.label}>
            <i style={{ background: entry.colour }} />
            {entry.label}
          </span>
        ))}
      </div>

      {node ? (
        <div className="vault-space-card">
          <strong>{node.name.replaceAll('-', ' ')}</strong>
          <span className="muted">
            {node.description}
            {linked.length > 0 ? ` · ${linked.length} connections` : ' · nothing linked to it yet'}
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
          Drag to turn it, scroll to zoom, and click anything to light up everything it connects to.
          Along is time, toward the middle is how much everything else depends on it, and around is
          which subject.
        </p>
      )}
    </div>
  );
}
