import { useEffect, useState } from 'react';
import { desktop } from './desktop.js';

export interface AgentSessionState {
  active: boolean;
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
  const [state, setState] = useState<AgentSessionState>({ active: false });

  useEffect(() => {
    const bridge = desktop();
    bridge?.onSiteSession?.((payload) => {
      // Only work this conversation asked for. A scheduled sync carries no
      // agent and belongs in no chat.
      if (payload.active && payload.agentId !== agentId) return;
      setState({ active: payload.active, portalId: payload.portalId });
    });
  }, [agentId]);

  return state;
}
