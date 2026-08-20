import { useCallback, useEffect, useRef, useState } from 'react';
import { desktop } from '../lib/desktop.js';
import { useAgentSession } from '../lib/useAgentSession.js';

/**
 * The browser the agent is driving, shown while it works.
 *
 * The frame is drawn here and the real browser is a native view the app
 * positions inside it -- a native view cannot take a CSS glow, and CSS cannot
 * render another site. So this owns where it sits and how big it is, and
 * reports that upward on every layout change.
 *
 * It exists because of what is being watched. The agent is signing into a
 * student's school account; a thing that does that off-screen asks for more
 * trust than it needs to. Small by default so it does not take over, and
 * expandable because "what is it doing right now" is a fair question.
 *
 * Scoped to one conversation: it shows in the chat whose agent asked for the
 * work, and nowhere else.
 */
export function AgentSession({ agentId }: { agentId: string }) {
  const bridge = desktop();
  const { active } = useAgentSession(agentId);
  const [expanded, setExpanded] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  const report = useCallback(() => {
    if (!bridge?.setSiteViewBounds) return;
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    void bridge.setSiteViewBounds({ x: box.x, y: box.y, width: box.width, height: box.height });
  }, [bridge]);

  useEffect(() => {
    if (!active) setExpanded(false);
  }, [active]);

  useEffect(() => {
    if (!active) {
      void bridge?.setSiteViewBounds?.(null);
      return;
    }
    report();
    // A native view does not move with the document, so anything that changes
    // the layout has to push new bounds or the browser is left behind.
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    const timer = setInterval(report, 500);
    return () => {
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      clearInterval(timer);
    };
  }, [active, expanded, bridge, report]);

  if (!bridge || !active) return null;

  return (
    <div className={`agent-session${expanded ? ' expanded' : ''}`}>
      <button
        className="agent-session-head"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="agent-session-pulse" aria-hidden="true" />
        <span>{expanded ? 'Working — tap to shrink' : 'Working — tap to watch'}</span>
      </button>
      <div className="agent-session-frame" ref={frame} />
    </div>
  );
}
