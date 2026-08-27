import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { parseMarkdown, type Span } from '../lib/markdown.js';
import { CENTRE, KEY, labelFor, neighbours, type DocEdge, type DocNode } from '../lib/vaultmap.js';

/**
 * The vault, and the page you are reading out of it.
 *
 * Everything here is the frame: what is fetched, what is open, and whether the
 * whole thing has been opened up. The ball itself lives in VaultScene, loaded
 * only when somebody looks, because it is most of a megabyte of renderer and
 * physics and a student on their way to the settings page should not pay for it.
 *
 * Reading sits beside the graph rather than under it. A picture of a vault is
 * worth a moment; a vault is worth reading, and the shortest path from seeing
 * that a page exists to knowing what it says should be one click.
 */

const VaultScene = lazy(() => import('./VaultScene.js'));

interface Graph {
  nodes: DocNode[];
  edges: DocEdge[];
}

export function VaultMap() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [reading, setReading] = useState<{ title: string; body: string } | null>(null);
  const [inside, setInside] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.vault.graph.$get();
      if (!res.ok) {
        setError('That could not be loaded.');
        return;
      }
      const data = (await res.json()) as Graph;
      setGraph(data);
      // The page describing them, open before anybody asks. It is the way in.
      if (data.nodes.some((node) => node.name === CENTRE)) setHeld(CENTRE);
    })();
  }, []);

  /*
   * What is being read, once something is held.
   *
   * A page, or failing that the note. The pages link outward to the evidence
   * they were written from -- a class page names its teacher -- and following
   * one of those links has to land somewhere.
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

  const joined = useMemo(
    () => (held && graph ? neighbours(graph.edges, held) : new Set<string>()),
    [graph, held],
  );

  // Escape leaves, because a full-screen thing with no way out is a trap.
  useEffect(() => {
    if (!inside) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInside(false);
    };
    window.addEventListener('keydown', leave);
    return () => window.removeEventListener('keydown', leave);
  }, [inside]);

  if (error) return <p className="muted">{error}</p>;
  if (!graph) return null;

  if (graph.nodes.length === 0) {
    return (
      <p className="muted">
        Nothing has been written about your school yet. Build your vault and this fills in.
      </p>
    );
  }

  const reader = (
    <aside className="vault-read">
      {reading === null ? (
        <p className="muted">Opening…</p>
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
  );

  return (
    <div className={inside ? 'vault-inside' : 'vault-map-wrap'}>
      <div className="vault-map-bar">
        <div className="vault-map-key">
          {KEY.map((entry) => (
            <span key={entry.label}>
              <i style={{ background: entry.colour }} />
              {entry.label}
            </span>
          ))}
        </div>
        <button type="button" className="ghost" onClick={() => setInside(!inside)}>
          {inside ? 'Leave vault' : 'Enter vault'}
        </button>
      </div>

      <div className="vault-stage">
        <div className="vault-canvas">
          <Suspense fallback={<p className="vault-loading">Opening your vault…</p>}>
            <VaultScene
              nodes={graph.nodes}
              edges={graph.edges}
              held={held}
              hovered={hovered}
              onHold={setHeld}
              onHover={setHovered}
            />
          </Suspense>
        </div>
        {reader}
      </div>
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
