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

/** The pages, then the evidence underneath them. */
const CLASS = '#a78bfa';
const CENTRE = '#f0abfc';
const CHATS = '#34d399';
const SCHOOL = '#fbbf24';

/*
 * Notes are coloured by what they are, not by which page they hang from.
 *
 * Brighter than the app's own palette, because these sit on near-black: a
 * thousand small points need a ground to be bright against.
 */
const NOTE: Record<string, string> = {
  Course: '#c4b5fd',
  Assignment: '#60a5fa',
  Topic: '#22d3ee',
  Person: '#f0abfc',
  Material: '#fbbf24',
};
const OWN_FILE = '#a3e635';
const GIVEN_FILE = '#fb923c';

function colourFor(node: DocNode): string {
  if (node.kind === 'document') {
    if (node.name === 'user') return CENTRE;
    if (node.name === 'chats') return CHATS;
    if (node.name === 'school') return SCHOOL;
    return CLASS;
  }
  if (node.kind === 'episode') {
    // What the student said themselves is the one thing here they wrote.
    if (node.source === 'student') return '#34d399';
    return node.source === 'classroom' ? '#94a3b8' : '#7c8bb0';
  }
  if (node.description === 'File') return node.source === 'drive' ? OWN_FILE : GIVEN_FILE;
  return NOTE[node.description] ?? '#8a8fae';
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
  { colour: NOTE.Course as string, label: 'Courses' },
  { colour: NOTE.Assignment as string, label: 'Work' },
  { colour: NOTE.Material as string, label: 'Readings' },
  { colour: GIVEN_FILE, label: 'Files from class' },
  { colour: OWN_FILE, label: 'Your own files' },
  { colour: '#94a3b8', label: 'Things that happened' },
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
   * What was clicked, once something is actually held.
   *
   * Only on a click, never on a hover. Seeing that a page exists is worth much
   * less than reading what it says, and a request per pointer move would be a
   * request per pointer move.
   *
   * A page, or failing that a note. The pages link outward to the evidence they
   * were written from -- a class page names its teacher as [[mme-rivard]] --
   * and those are notes rather than pages. Following one has to land somewhere,
   * or the panel sits on "Opening..." for a name that was never going to
   * resolve.
   */
  useEffect(() => {
    if (!focused) {
      setHeld(null);
      return;
    }
    setHeld(null);

    let dropped = false;
    void (async () => {
      const page = await api.vault.doc[':name'].$get({ param: { name: focused } });
      // A click that lands while an older request is in flight must win, or the
      // panel fills in with whatever the student stopped caring about.
      if (dropped) return;
      if (page.ok) {
        setHeld((await page.json()).document.body);
        return;
      }

      const note = await api.vault.note[':name'].$get({ param: { name: focused } });
      if (dropped) return;
      setHeld(note.ok ? (await note.json()).note.body : 'There is nothing here to open.');
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

      const items = place(graph.nodes, graph.edges, width, height);
      placed.current = items;
      const at = new Map(items.map((item) => [item.node.name, item]));

      /*
       * Edges under everything, and only the ones worth the ink.
       *
       * Ten thousand lines at full strength is a grey wash with the structure
       * lost inside it. The near ones -- page to page, page to what it was
       * written from -- carry the shape; the rest are texture until something
       * is lit, and then the ones touching it are all that matter.
       */
      for (const edge of graph.edges) {
        const from = at.get(edge.from);
        const to = at.get(edge.to);
        if (!from || !to) continue;

        const involved = lit && (lit.name === edge.from || lit.name === edge.to);
        const near = Math.min(from.depth, to.depth) <= 1;
        if (!involved && !near && graph.edges.length > 400) continue;

        paint.strokeStyle = involved
          ? 'rgba(167,139,250,0.85)'
          : near
            ? 'rgba(148,163,184,0.22)'
            : 'rgba(148,163,184,0.07)';
        paint.lineWidth = involved ? 1.6 : 1;
        paint.beginPath();
        paint.moveTo(from.x, from.y);
        paint.lineTo(to.x, to.y);
        paint.stroke();
      }

      // Notes first, pages over them, so a page is never buried by its evidence.
      for (const item of [...items].sort((a, b) => b.depth - a.depth)) {
        const dimmed =
          lit !== null && lit.name !== item.node.name && !lit.joined.has(item.node.name);
        paint.globalAlpha = dimmed ? (item.depth > 1 ? 0.12 : 0.3) : 1;

        paint.fillStyle = colourFor(item.node);
        paint.beginPath();
        paint.arc(item.x, item.y, item.r, 0, Math.PI * 2);
        paint.fill();

        if (focused === item.node.name) {
          paint.strokeStyle = '#ffffff';
          paint.lineWidth = 2;
          paint.stroke();
        }
      }

      /*
       * Labels for the pages only, plus whatever is under the pointer.
       *
       * Four thousand labels is a solid block of text. The pages are what
       * somebody is navigating by, and anything else can be read by pointing
       * at it.
       */
      paint.font = '13px system-ui, sans-serif';
      paint.textAlign = 'center';
      for (const item of items) {
        const named = item.depth <= 1 || item.node.name === hovered || item.node.name === focused;
        if (!named) continue;

        const dimmed =
          lit !== null && lit.name !== item.node.name && !lit.joined.has(item.node.name);
        paint.globalAlpha = dimmed ? 0.35 : 1;
        paint.fillStyle = '#e8ecff';
        paint.fillText(labelFor(item.node.name), item.x, item.y + item.r + 16);
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
            {graph.nodes.find((node) => node.name === focused)?.description ??
              'From the notes this was written from'}
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
