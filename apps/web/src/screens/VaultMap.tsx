import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/auth.js';
import { parseMarkdown, type Span } from '../lib/markdown.js';
import { loadGraph, type Graph } from '../lib/vaultGraph.js';
import { drawStill, recallStill, rememberStill, type Still } from '../lib/vaultStill.js';
import { CENTRE, labelFor, neighbours } from '../lib/vaultmap.js';

/**
 * The vault, and the page you are reading out of it.
 *
 * Everything here is the frame: what is fetched, what is open, and whether the
 * whole thing has been opened up. The ball itself lives in VaultScene, fetched
 * only when somebody looks.
 *
 * Two shapes. On the settings page it is a picture of your school, the width of
 * the page, and nothing else -- reading is what going inside is for, and a
 * reader squeezed in beside it left neither enough room. Inside, it takes the
 * window, with the page you are on beside it.
 */

const VaultScene = lazy(() => import('./VaultScene.js'));

export function VaultMap({ onConnect }: { onConnect: () => void }) {
  const { data: session } = useSession();
  const userId = session?.user.id ?? null;

  const [graph, setGraph] = useState<Graph | null>(null);
  /*
   * The picture is on screen before the graph is: the one drawn last time,
   * remembered in the browser, stands in until the fresh one arrives and
   * takes its place -- in the same positions, so nothing appears to move.
   */
  const [still, setStill] = useState<Still | null>(() => (userId ? recallStill(userId) : null));
  const [held, setHeld] = useState<string | null>(null);
  const [reading, setReading] = useState<{ title: string; body: string } | null>(null);
  const [inside, setInside] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void loadGraph().then((loaded) => {
      if (gone) return;
      if (!loaded) {
        setError('That could not be loaded.');
        return;
      }
      setGraph(loaded);
    });
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return;
    const drawn = drawStill(graph.nodes, graph.edges);
    setStill(drawn);
    if (userId) rememberStill(userId, drawn);
  }, [graph, userId]);

  /* Going in opens the page describing them, because that is the way in. */
  useEffect(() => {
    if (inside && held === null && graph?.nodes.some((node) => node.name === CENTRE)) {
      setHeld(CENTRE);
    }
  }, [inside, held, graph]);

  /*
   * What is being read, once something is held.
   *
   * A page, or failing that the note. The pages link outward to the evidence
   * they were written from -- a class page names its teacher -- so following
   * one of those has to land somewhere.
   */
  useEffect(() => {
    if (!held) {
      setReading(null);
      return;
    }
    let dropped = false;
    setReading(null);

    void (async () => {
      const page = await api.vault.doc[':name'].$get({ param: { name: held } });
      // A click landing while an older request is in flight must win, or the
      // panel fills in with whatever the reader stopped caring about.
      if (dropped) return;
      if (page.ok) {
        setReading({ title: labelFor(held), body: (await page.json()).document.body });
        return;
      }

      const note = await api.vault.note[':name'].$get({ param: { name: held } });
      if (dropped) return;
      setReading({
        title: labelFor(held),
        body: note.ok ? (await note.json()).note.body : 'There is nothing here to open.',
      });
    })();

    return () => {
      dropped = true;
    };
  }, [held]);

  /* Letting go of a thing, and lighting the whole vault back up. */
  const clear = useCallback(() => setHeld(null), []);

  const joined = useMemo(
    () => (held && graph ? neighbours(graph.edges, held) : new Set<string>()),
    [graph, held],
  );

  /*
   * Escape leaves, and the page behind stops scrolling while you are in here.
   *
   * A full-screen thing with no way out is a trap, and a page that scrolls
   * underneath one is why leaving it puts you somewhere you did not expect.
   */
  useEffect(() => {
    if (!inside) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInside(false);
    };
    const held = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', leave);

    return () => {
      document.body.style.overflow = held;
      window.removeEventListener('keydown', leave);
    };
  }, [inside]);

  if (error) return <p className="muted">{error}</p>;

  /*
   * Empty because nothing is connected, almost always. So the frame is drawn
   * anyway, and what is in it is the way to fill it rather than a note that
   * it has not been filled.
   */
  if (graph && graph.nodes.length === 0) {
    return (
      <div className="vault-still vault-still-empty">
        <p className="vault-empty">Connect everything to build your vault.</p>
        <button type="button" className="primary vault-open" onClick={onConnect}>
          Connect
        </button>
      </div>
    );
  }

  if (!inside) {
    /*
     * A still, not the vault itself.
     *
     * The scene is three thousand nodes and a physics simulation behind a lazy
     * chunk; running it to fill a card in settings meant a second of nothing
     * followed by something you were not meant to touch. This is one pass of
     * SVG over the same dark, and it is on screen with the panel rather than
     * after it -- the frame is drawn even before there is anything to put in it.
     */
    return (
      <div className="vault-still">
        {still && <VaultThumbnail still={still} />}
        <button type="button" className="primary vault-open" onClick={() => setInside(true)}>
          Open vault
        </button>
      </div>
    );
  }

  const ball = graph ? (
    <Stage>
      {(width, height) => (
        <Suspense fallback={<p className="vault-loading">Opening your vault…</p>}>
          <VaultScene
            nodes={graph.nodes}
            edges={graph.edges}
            held={held}
            width={width}
            height={height}
            onHold={setHeld}
            onClear={clear}
          />
        </Suspense>
      )}
    </Stage>
  ) : (
    <p className="vault-loading">Opening your vault…</p>
  );

  /*
   * Through a portal, onto the body.
   *
   * A fixed overlay is only fixed to the window if no ancestor has made itself
   * a containing block, and the settings page has several. Rendered where it
   * sits in the tree, this covered part of the page and let the rest show
   * through around the edges.
   */
  return createPortal(
    <div className="vault-inside">
      <header className="vault-inside-bar">
        <button type="button" className="ghost" onClick={() => setInside(false)}>
          Leave vault
        </button>
      </header>

      <div className="vault-inside-stage">
        <div className="vault-frame">{ball}</div>
        <aside className="vault-read">
          {reading === null ? (
            <p className="muted">Click anything to read it.</p>
          ) : (
            <>
              <header className="vault-read-head">
                <strong>{reading.title}</strong>
                {joined.size > 0 && (
                  <span className="muted">
                    {joined.size} connected {joined.size === 1 ? 'note' : 'notes'}
                  </span>
                )}
              </header>
              <div className="vault-read-body">{render(reading.body, setHeld)}</div>
            </>
          )}
        </aside>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A box that knows how big it is.
 *
 * The renderer sizes its canvas once, from whatever it is given. Left to read
 * its own container it measured zero -- the element had not been laid out when
 * the lazy chunk arrived -- and drew a graph nobody could see into a box of the
 * wrong shape.
 */
function Stage({ children }: { children: (width: number, height: number) => React.ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const measure = useCallback(() => {
    const at = box.current?.getBoundingClientRect();
    if (at) setSize({ width: Math.round(at.width), height: Math.round(at.height) });
  }, []);

  useEffect(() => {
    measure();
    const watch = new ResizeObserver(measure);
    if (box.current) watch.observe(box.current);
    return () => watch.disconnect();
  }, [measure]);

  return (
    <div ref={box} className="vault-stage">
      {size.width > 0 && size.height > 0 ? children(size.width, size.height) : null}
    </div>
  );
}

/** A page, rendered, with its links made into somewhere to go. */
function render(body: string, go: (name: string) => void) {
  return parseMarkdown(body).map((block, i) => {
    if (block.kind === 'heading') {
      const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3';
      return <Tag key={i}>{inline(block.spans, go)}</Tag>;
    }
    if (block.kind === 'list') {
      return (
        <ul key={i}>
          {block.items.map((item, j) => (
            <li key={j}>{inline(item, go)}</li>
          ))}
        </ul>
      );
    }
    return <p key={i}>{inline(block.spans, go)}</p>;
  });
}

function inline(spans: Span[], go: (name: string) => void) {
  return spans.map((span, i) => {
    if ('link' in span) {
      return (
        <button key={i} type="button" className="vault-map-inline" onClick={() => go(span.link)}>
          {labelFor(span.link)}
        </button>
      );
    }
    return span.bold ? <strong key={i}>{span.text}</strong> : <span key={i}>{span.text}</span>;
  });
}

/**
 * The vault as a still picture: the same dark, the same dots, seen from
 * across the room. Softened a little rather than blurred out, because what it
 * is for is recognising the thing, and a smear of one colour is not it.
 */
function VaultThumbnail({ still }: { still: Still }) {
  return (
    <svg
      className="vault-thumb"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <g className="vault-thumb-links">
        {still.links.map(([from, to], i) => {
          const a = still.dots[from];
          const b = still.dots[to];
          if (!a || !b) return null;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
      </g>
      <g className="vault-thumb-dots">
        {still.dots.map((dot, i) => (
          <circle key={i} cx={dot.x} cy={dot.y} r={dot.r} />
        ))}
      </g>
    </svg>
  );
}
