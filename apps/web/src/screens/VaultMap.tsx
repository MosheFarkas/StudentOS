import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  neighbours,
  pick,
  place,
  type DocEdge,
  type DocNode,
  type Placed,
} from '../lib/vaultmap.js';

/**
 * The vault, as the handful of pages it is.
 *
 * What this replaces drew every note -- four thousand of them, on a cylinder
 * you could turn, time along the axis and course around it. Every axis carried
 * something true and no student ever learned anything from it, because a
 * picture of four thousand things is a picture of how many there are.
 *
 * The pages are different. There are about ten and a student recognises all of
 * them: their classes, their school, what they have told it. At that size the
 * arrangement can mean something -- what a page is written FROM sits around the
 * page written from it -- and clicking one can show you what it actually says,
 * which is the part that was never possible before.
 *
 * Dark on purpose, inside an otherwise light app. This is a window onto
 * something, the way a map is, not another panel.
 */

/** Class pages, and the two that are not classes. */
const CLASS = '#a78bfa';
const CENTRE = '#f0abfc';
const CHATS = '#34d399';
const SCHOOL = '#fbbf24';

function colourFor(name: string): string {
  if (name === 'user') return CENTRE;
  if (name === 'chats') return CHATS;
  if (name === 'school') return SCHOOL;
  return CLASS;
}

/** "class-french" is the filename; "French" is what a student calls it. */
function labelFor(name: string): string {
  return name.replace(/^class-/, '').replaceAll('-', ' ');
}

const KEY: { colour: string; label: string }[] = [
  { colour: CENTRE, label: 'You' },
  { colour: CLASS, label: 'Your classes' },
  { colour: SCHOOL, label: 'Your school' },
  { colour: CHATS, label: 'What you have told it' },
];

export function VaultMap() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [graph, setGraph] = useState<{ nodes: DocNode[]; edges: DocEdge[] } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const placed = useRef<Placed[]>([]);

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
   * The page itself, once something is actually held.
   *
   * Only on a click, never on a hover. Seeing that a page exists is worth much
   * less than reading what it says, and a request per pointer move would be a
   * request per pointer move.
   */
  useEffect(() => {
    if (!focused) {
      setHeld(null);
      return;
    }
    let dropped = false;
    void (async () => {
      const res = await api.vault.doc[':name'].$get({ param: { name: focused } });
      // A click that lands while an older request is in flight must win, or the
      // panel fills in with whatever the student stopped caring about.
      if (!res.ok || dropped) return;
      const data = await res.json();
      setHeld(data.document.body);
    })();
    return () => {
      dropped = true;
    };
  }, [focused]);

  /** What is lit: the page under the pointer, or the one being read. */
  const lit = useMemo(() => {
    const name = hovered ?? focused;
    if (!name || !graph) return null;
    return { name, joined: neighbours(graph.edges, name) };
  }, [hovered, focused, graph]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph) return;

    const draw = () => {
      const scale = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = width * scale;
      canvas.height = height * scale;

      const paint = canvas.getContext('2d');
      if (!paint) return;
      paint.setTransform(scale, 0, 0, scale, 0, 0);

      const ground = paint.createLinearGradient(0, 0, 0, height);
      ground.addColorStop(0, '#141a3d');
      ground.addColorStop(1, '#07091c');
      paint.fillStyle = ground;
      paint.fillRect(0, 0, width, height);

      const items = place(graph.nodes, width, height);
      placed.current = items;
      const at = new Map(items.map((item) => [item.node.name, item]));

      // Edges under the pages, so a line never crosses a label.
      for (const edge of graph.edges) {
        const from = at.get(edge.from);
        const to = at.get(edge.to);
        if (!from || !to) continue;

        const involved = lit && (lit.name === edge.from || lit.name === edge.to);
        paint.strokeStyle = involved ? 'rgba(167,139,250,0.75)' : 'rgba(148,163,184,0.18)';
        paint.lineWidth = involved ? 2 : 1;
        paint.beginPath();
        paint.moveTo(from.x, from.y);
        paint.lineTo(to.x, to.y);
        paint.stroke();
      }

      for (const item of items) {
        const dimmed =
          lit !== null && lit.name !== item.node.name && !lit.joined.has(item.node.name);
        paint.globalAlpha = dimmed ? 0.3 : 1;

        paint.fillStyle = colourFor(item.node.name);
        paint.beginPath();
        paint.arc(item.x, item.y, item.r, 0, Math.PI * 2);
        paint.fill();

        if (focused === item.node.name) {
          paint.strokeStyle = '#ffffff';
          paint.lineWidth = 2;
          paint.stroke();
        }

        paint.globalAlpha = dimmed ? 0.4 : 1;
        paint.fillStyle = '#e8ecff';
        paint.font = '13px system-ui, sans-serif';
        paint.textAlign = 'center';
        paint.fillText(labelFor(item.node.name), item.x, item.y + item.r + 18);
      }

      paint.globalAlpha = 1;
    };

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [graph, lit, focused]);

  const nameAt = (event: { clientX: number; clientY: number }): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    return pick(placed.current, event.clientX - box.left, event.clientY - box.top);
  };

  if (error) return <p className="muted">{error}</p>;
  if (!graph) return null;

  if (graph.nodes.length === 0) {
    return (
      <p className="muted">
        Nothing has been written about your school yet. Build your vault and this fills in.
      </p>
    );
  }

  return (
    <div className="vault-map-wrap">
      <canvas
        ref={canvasRef}
        className="vault-map"
        onMouseMove={(event) => setHovered(nameAt(event))}
        onMouseLeave={() => setHovered(null)}
        onClick={(event) => setFocused(nameAt(event))}
      />

      <div className="vault-map-key">
        {KEY.map((entry) => (
          <span key={entry.label}>
            <i style={{ background: entry.colour }} />
            {entry.label}
          </span>
        ))}
      </div>

      {focused && (
        <div className="card vault-map-card">
          <strong>{labelFor(focused)}</strong>
          <span className="muted">
            {graph.nodes.find((node) => node.name === focused)?.description}
          </span>
          {held === null ? (
            <p className="muted vault-map-body">Opening…</p>
          ) : (
            <p className="vault-map-body">{withLinks(held, setFocused)}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A page body, with its [[wikilinks]] turned into somewhere to go.
 *
 * The links are the whole structure, and rendered as raw brackets they are
 * punctuation the student has to ignore. Made clickable they are the shortest
 * path from "what does it say about me" to the class it says it about.
 */
function withLinks(body: string, go: (name: string) => void) {
  return body.split(/(\[\[[^\]]+\]\])/g).map((piece, index) => {
    const link = /^\[\[([^\]]+)\]\]$/.exec(piece);
    if (!link) return <span key={index}>{piece}</span>;
    const name = link[1] as string;
    return (
      <button key={index} type="button" className="vault-map-inline" onClick={() => go(name)}>
        {labelFor(name)}
      </button>
    );
  });
}
