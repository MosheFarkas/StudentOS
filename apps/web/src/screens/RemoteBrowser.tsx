import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { keyEvents, toPagePoint } from '../lib/remote-input.js';

interface Frame {
  data: string;
  width: number;
  height: number;
  seq: number;
}

/**
 * The agent's browser, for a website that cannot hold one.
 *
 * In the desktop app the student sees the real thing -- a Chromium view the
 * app positions in the window. A browser tab cannot be given that, and cannot
 * fake it either: every site worth showing here refuses to be embedded, and
 * an iframe would be a different browser with different cookies showing a
 * login page rather than their portal.
 *
 * So the pixels are carried. The machine doing the work screencasts frames up
 * and this paints them; anything done here is sent back and replayed in the
 * real page. It is a picture you can click, which is as close as the web gets.
 *
 * Nothing is stored at either end -- frames live in memory on the server for
 * seconds. See apps/api/src/live-session.ts.
 */
export function RemoteBrowser({ agentId }: { agentId: string }) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [gone, setGone] = useState(false);
  const surface = useRef<HTMLImageElement>(null);
  /*
   * Read inside the polling loop, which is started once and must not be torn
   * down and rebuilt every time a frame lands -- that would abandon a request
   * mid-hold on every repaint.
   */
  const since = useRef(0);

  useEffect(() => {
    let watching = true;
    since.current = 0;

    void (async () => {
      while (watching) {
        try {
          const res = await api.agents[':id'].session.frame.$get({
            param: { id: agentId },
            query: { since: String(since.current) },
          });

          if (!watching) return;
          if (res.status === 204) {
            // Nothing repainted. Perfectly ordinary -- a finished page emits
            // no frames at all -- so ask again rather than treating it as an
            // ending.
            continue;
          }
          if (!res.ok) throw new Error(String(res.status));

          const next = (await res.json()) as Frame;
          since.current = next.seq;
          setFrame(next);
          setGone(false);
        } catch {
          if (!watching) return;
          // Offline, or the turn is over and the server let the channel go.
          // Slow down rather than hammering it.
          setGone(true);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    })();

    return () => {
      watching = false;
    };
  }, [agentId]);

  const send = useCallback(
    (events: unknown[]) => {
      if (events.length === 0) return;
      void api.agents[':id'].session.input
        .$post({ param: { id: agentId }, json: { events } as never })
        .catch(() => {
          // A lost click is a lost click. Retrying it later would land it
          // somewhere the page has moved on from, which is worse.
        });
    },
    [agentId],
  );

  /** Where on the real page this pointer event landed. */
  const at = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const box = surface.current?.getBoundingClientRect();
      if (!box || !frame) return { x: 0, y: 0 };
      return toPagePoint(
        { x: event.clientX - box.left, y: event.clientY - box.top },
        { width: box.width, height: box.height },
        { width: frame.width, height: frame.height },
      );
    },
    [frame],
  );

  if (!frame) {
    return (
      <div className="remote-browser waiting">
        <span className="muted">
          {gone ? 'Waiting for your computer…' : 'Opening the page on your computer…'}
        </span>
      </div>
    );
  }

  return (
    <img
      ref={surface}
      className="remote-browser"
      src={`data:image/jpeg;base64,${frame.data}`}
      alt="The page the agent is looking at"
      draggable={false}
      /*
       * Focusable, because keys go to whatever has focus and there is no
       * input here to receive them -- the real one is on another machine.
       */
      tabIndex={0}
      onMouseDown={(e) => {
        e.preventDefault();
        surface.current?.focus();
        const p = at(e);
        send([{ kind: 'mouse', type: 'mousePressed', ...p, button: 'left', clickCount: 1 }]);
      }}
      onMouseUp={(e) => {
        const p = at(e);
        send([{ kind: 'mouse', type: 'mouseReleased', ...p, button: 'left', clickCount: 1 }]);
      }}
      onMouseMove={(e) => {
        // Only while dragging. Streaming every idle mousemove would spend the
        // channel on nothing.
        if (e.buttons !== 1) return;
        const p = at(e);
        send([{ kind: 'mouse', type: 'mouseMoved', ...p, button: 'left', clickCount: 0 }]);
      }}
      onWheel={(e) => {
        const p = at(e);
        send([{ kind: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY }]);
      }}
      onKeyDown={(e) => {
        // Held here rather than let through: the page underneath is a picture,
        // and space or the arrows would scroll the conversation instead.
        e.preventDefault();
        send(keyEvents(e.key, e.code));
      }}
    />
  );
}
