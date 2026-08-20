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
 * Whether a browser the app is reporting belongs in this conversation.
 *
 * Work an agent does carries the id of the chat that asked for it. A six-
 * hourly refresh, "Sync now" from the Sites list, and adding a site carry
 * none: nobody asked for those from a conversation, so there is no
 * conversation they belong in.
 *
 * Comparing exactly is the whole point. Skipping only ids that disagree --
 * `theirs && theirs !== mine` -- reads as the same rule and is not: an absent
 * id passes it, so unasked-for work appeared in whichever chat was open.
 * Absent has to mean no chat, not every chat.
 */
export function belongsInChat(sessionAgentId: string | null | undefined, agentId: string): boolean {
  return sessionAgentId === agentId;
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
      if (!belongsInChat(now.agentId, agentId)) return;
      setState({ active: now.active, showing: true, portalId: now.portalId ?? undefined });
    });

    /*
     * Dropped on the way out, or every conversation visited this session
     * keeps a listener holding the state of a panel that no longer exists.
     */
    const stop = bridge?.onSiteSession?.((payload) => {
      if (!belongsInChat(payload.agentId, agentId)) return;
      setState({
        active: payload.active,
        // The page stays after the work ends. A browser that vanishes with
        // the spinner takes the evidence of what it did with it.
        showing: payload.active || Boolean(payload.showing),
        portalId: payload.portalId,
      });
    });
    return () => stop?.();
  }, [agentId]);

  return state;
}
