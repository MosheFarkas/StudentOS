import { useCallback, useEffect, useRef, useState } from 'react';
import { desktop } from '../lib/desktop.js';
import { useAgentSession } from '../lib/useAgentSession.js';
import { RemoteBrowser } from './RemoteBrowser.js';

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
 * That native view is drawn over this page, not under it, which decides the
 * whole layout: anything the student needs to see or press has to live
 * outside the rectangle handed to it. Hence the bar. A close button placed on
 * top of the frame is behind the site and might as well not exist.
 *
 * Clicking the page opens it, and only opens it. Nothing says so, because a
 * browser that grows when you press it does not need a label explaining that
 * it will -- but a browser that shrinks when you press it is just broken, so
 * the close button is the only way back.
 *
 * It stays after the work finishes, without the aura. The page the agent
 * ended on is the evidence of what it did, and a browser that vanishes with
 * the spinner takes that with it -- but a glow on something no longer
 * happening would be saying something untrue.
 */
export function AgentSession({ agentId, working }: { agentId: string; working: boolean }) {
  const bridge = desktop();
  const { active, showing, portalId } = useAgentSession(agentId);
  /*
   * Lit for the whole time the agent is working, not only while a page is
   * being driven. Between two steps it is still working, and a glow that
   * blinks out in the gaps looks like it stopped.
   */
  const lit = active || working;
  const [expanded, setExpanded] = useState(false);
  /*
   * Whether a carried frame has ever arrived for this conversation.
   *
   * In a browser tab there is no bridge, so `showing` -- which is fed by the
   * app -- is always false, and the panel used to live only for as long as the
   * request was in flight. It vanished the instant the reply landed, taking
   * the page the agent had just been reading with it. This is the web's own
   * answer to the same question: something was shown, so keep showing it.
   */
  const [sawFrame, setSawFrame] = useState(false);
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

  /*
   * A click lands on the site, not on this page, so the view forwards it.
   *
   * It only ever opens. Toggling meant that once the browser was full-screen,
   * every click on the page put it away again -- pressing a link, a search
   * box, anything -- which makes an expanded browser impossible to actually
   * use. Once it is open the clicks belong to the site; the way back out is
   * the close button, which is why that button exists only while expanded.
   */
  useEffect(() => {
    const stop = bridge?.onSiteViewClick?.(() => setExpanded(true));
    return () => stop?.();
  }, [bridge]);

  useEffect(() => {
    if (!showing) return;
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

  useEffect(() => {
    if (!showing) return;
    /*
     * Put the browser away when this panel goes -- leaving the conversation,
     * or the work being cleared.
     *
     * This used to be left alone, because two panels were mounted at once
     * while moving between conversations and the outgoing one's null landed
     * last, blanking the incoming one. That only happened because work with
     * no agent was shown in every chat; now that it is shown in none, one
     * panel exists at a time and there is nothing to race with. Leaving the
     * bounds behind is what let a browser sit over the Sites list, drawn
     * where some conversation used to be.
     *
     * Kept apart from reporting so that expanding, which changes where the
     * browser goes, does not blink it off and on along the way.
     */
    return () => void bridge?.setSiteViewBounds?.(null);
  }, [showing, bridge]);

  /*
   * In a browser tab there is no native view to position, so the frames the
   * app is sending are painted instead. Same panel, same bar, same close
   * button -- the difference is a picture you can click rather than the
   * browser itself, which is as close as a web page is allowed to get.
   *
   * Shown whenever the agent is working, because unlike the app this cannot
   * ask what is already on screen: the frames are the only signal there is.
   */
  if (!bridge) {
    /*
     * Always mounted, so it keeps asking for frames and can say when one
     * arrives -- a panel that only appeared once it was already needed would
     * never be listening at the moment that mattered. Hidden rather than
     * absent until there is something to see.
     */
    const present = working || showing || sawFrame;
    return (
      <div
        className={`agent-browser${expanded ? ' expanded' : ''}${lit ? ' working' : ''}${
          present ? '' : ' agent-browser-unseen'
        }`}
      >
        <div className="agent-browser-bar">
          {expanded && (
            <button
              className="agent-browser-close"
              onClick={() => setExpanded(false)}
              aria-label="Close"
            />
          )}
          <span className="agent-browser-label">
            {portalId ?? 'on your computer'}
            {lit && (
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
          <button className="agent-browser-grow" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Shrink' : 'Expand'}
          </button>
        </div>
        <RemoteBrowser agentId={agentId} onFrame={() => setSawFrame(true)} />
      </div>
    );
  }

  if (!showing) return null;

  return (
    <div className={`agent-browser${expanded ? ' expanded' : ''}${lit ? ' working' : ''}`}>
      {/*
        Above the page rather than over it. The native view covers every pixel
        of the frame, so this strip is the only place a control can be both
        seen and pressed.
      */}
      <div className="agent-browser-bar">
        {/*
          Only while expanded, because closing the expansion is all it does.
          Sitting there beforehand, it was a button that did nothing.
        */}
        {expanded && (
          <button
            className="agent-browser-close"
            onClick={() => setExpanded(false)}
            aria-label="Close"
          />
        )}
        <span className="agent-browser-label">
          {portalId}
          {lit && (
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
        </span>
      </div>

      <div
        className="agent-browser-frame"
        ref={frame}
        onClick={() => setExpanded(true)}
        role="presentation"
      />
    </div>
  );
}
