import { useCallback, useEffect, useRef, useState } from 'react';
import { desktop } from '../lib/desktop.js';
import { useAgentSession } from '../lib/useAgentSession.js';

/**
 * The browser the agent is driving, sitting in the conversation.
 *
 * It lives in the message column rather than floating in a corner: the work
 * belongs to this exchange, and something hovering over the app reads as
 * having happened to the student rather than been asked for by them.
 *
 * The frame is drawn here and the real browser is a native view the app
 * positions inside it -- a native view cannot take a CSS aura, and CSS cannot
 * render another site. So this owns where it sits; the app owns what is in
 * it, which is also why bounds are pushed on every layout change.
 *
 * Clicking anywhere on it opens it. Nothing says so, because a browser that
 * grows when you press it does not need a label explaining that it will.
 *
 * It stays after the work finishes, without the aura. The page the agent
 * ended on is the evidence of what it did, and a browser that vanishes with
 * the spinner takes that with it -- but a glow on something no longer
 * happening would be saying something untrue.
 */
export function AgentSession({ agentId }: { agentId: string }) {
  const bridge = desktop();
  const { active, showing, portalId } = useAgentSession(agentId);
  const [expanded, setExpanded] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  const report = useCallback(() => {
    if (!bridge?.setSiteViewBounds) return;
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    void bridge.setSiteViewBounds({ x: box.x, y: box.y, width: box.width, height: box.height });
  }, [bridge]);

  useEffect(() => {
    if (!showing) setExpanded(false);
  }, [showing]);

  // A click lands on the site, not on this page, so the view forwards it.
  useEffect(() => {
    bridge?.onSiteViewClick?.(() => setExpanded((open) => !open));
  }, [bridge]);

  useEffect(() => {
    if (!showing) {
      void bridge?.setSiteViewBounds?.(null);
      return;
    }
    report();
    // A native view does not move with the document, so anything that changes
    // the layout has to push new bounds or the browser is left behind.
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    const timer = setInterval(report, 400);
    return () => {
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      clearInterval(timer);
    };
  }, [showing, expanded, bridge, report]);

  if (!bridge || !showing) return null;

  return (
    <div className={`agent-browser${expanded ? ' expanded' : ''}${active ? ' working' : ''}`}>
      <div
        className="agent-browser-frame"
        ref={frame}
        onClick={() => setExpanded(!expanded)}
        role="presentation"
      />
      <span className="agent-browser-label">
        {portalId}
        {active && (
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </span>
    </div>
  );
}
