import { useEffect, useState } from 'react';
import { desktop } from './desktop.js';

export interface AgentSessionState {
  /** The agent is driving it right now. Only this puts an aura on it. */
  active: boolean;
  /** There is a page on screen, working or not. */
  showing: boolean;
  portalId?: string;
}

/**
 * Whether this conversation's agent is currently driving a browser.
 *
 * Shared by the panel and the thinking line so they cannot disagree -- one
 * saying the agent is working while the other has already stopped is worse
 * than neither, because it makes the app look like it has lost track.
 */
export function useAgentSession(agentId: string): AgentSessionState {
  const [state, setState] = useState<AgentSessionState>({ active: false, showing: false });

  useEffect(() => {
    const bridge = desktop();

    /*
     * Ask what is already there before listening for changes. A student who
     * leaves the conversation and comes back has missed every event, and
     * without this the browser they were watching is simply gone.
     */
    void bridge?.getSiteSession?.().then((reply) => {
      const now = reply?.value;
      if (!now?.showing) return;
      if (now.agentId && now.agentId !== agentId) return;
      setState({ active: now.active, showing: true, portalId: now.portalId ?? undefined });
    });
    bridge?.onSiteSession?.((payload) => {
      // Only work this conversation asked for. A scheduled sync carries no
      // agent and belongs in no chat.
      if (payload.agentId && payload.agentId !== agentId) return;
      setState({
        active: payload.active,
        // The page stays after the work ends. A browser that vanishes with
        // the spinner takes the evidence of what it did with it.
        showing: payload.active || Boolean(payload.showing),
        portalId: payload.portalId,
      });
    });
  }, [agentId]);

  return state;
}
