import { useEffect, useRef, useState } from 'react';
import { AgentSession } from './AgentSession.js';
import { useAgentSession } from '../lib/useAgentSession.js';
import type { Agent, AgentActivity, Message } from '@contexto/shared';
import { api } from '../lib/api.js';
import { sameConversation } from '../lib/conversation.js';
import type { PreviewTarget } from '../lib/preview.js';
import { FilePreview } from './FilePreview.js';
import { AgentMemory } from './AgentMemory.js';
import { VaultBrowser } from './VaultBrowser.js';
import { MessageText } from './MessageText.js';
import { LogoMark } from './LogoMark.js';
import { useReportWorking } from '../lib/working.js';
import { activityKey, pickPhrase } from '../lib/thinkingPhrases.js';

interface Props {
  agentId: string;
  onBack: () => void;
}

export function Chat({ agentId, onBack }: Props) {
  /*
   * Loaded here rather than handed down, because the id now comes from the
   * URL. That is what lets a student reopen a conversation from a link, or
   * refresh mid-chat without being thrown back to the list.
   */
  const [agent, setAgent] = useState<Agent | null>(null);
  const [missing, setMissing] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /*
   * A turn running that this page did not start -- asked before a refresh, or
   * from the other window. Without it the student sees a question of theirs
   * sitting unanswered and then an answer appearing from nowhere.
   */
  const [pending, setPending] = useState(false);
  /*
   * The step the turn is on, as last reported. Held rather than rendered
   * directly: what the student reads is a phrase chosen to suit it, and tool
   * names are not something to put in front of them.
   */
  const [activity, setActivity] = useState<AgentActivity | undefined>(undefined);
  const session = useAgentSession(agentId);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAgent(null);
    setMissing(false);
    setMessages([]);

    void (async () => {
      const detail = await api.agents[':id'].$get({ param: { id: agentId } });
      if (!detail.ok) {
        // 404 covers both "deleted" and "belongs to someone else" -- the API
        // deliberately does not distinguish them.
        setMissing(true);
        return;
      }
      setAgent((await detail.json()).agent);

      const history = await api.agents[':id'].messages.$get({ param: { id: agentId } });
      if (history.ok) {
        const body = await history.json();
        setMessages(body.messages);
        setPending(body.pending);
        setActivity(body.activity);
      }
    })();
  }, [agentId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  useEffect(() => {
    /*
     * Keep this conversation level with the other window onto it.
     *
     * The app and the website are the same page against the same account, and
     * a student moves between them mid-conversation. Loading the history once
     * on mount meant whichever one they were not typing into quietly went out
     * of date: a question asked in the app never appeared on the website, and
     * the answer to it never did either.
     *
     * It runs during a turn of our own as well, but only for what the turn is
     * doing -- the messages it brings back are ignored. The student's own
     * message is on screen optimistically and the reply is already on its way
     * here; a poll landing in the middle would replace both with the server's
     * older view of the same conversation.
     */
    let live = true;

    const pull = async () => {
      const res = await api.agents[':id'].messages.$get({ param: { id: agentId } });
      if (!live || !res.ok) return;
      const body = await res.json();
      /*
       * Kept as the same object while the step is unchanged. A fresh one every
       * poll would read as the agent having moved on, and the line would churn
       * through words while it sat on one tool for a minute.
       */
      setActivity((prev) =>
        activityKey(prev) === activityKey(body.activity) ? prev : body.activity,
      );

      /*
       * Everything below is the server's view of a conversation this page is
       * not currently changing. During a turn of our own, `sending` already
       * says a turn is running and the reply is already on its way here --
       * taking the server's `pending` as well would leave it set behind our
       * back, and the line would sit under the finished answer for another
       * four seconds insisting the agent was still working.
       */
      if (sending) return;
      setPending(body.pending);
      // Replaced only when something was actually said, so the list is not
      // rebuilt under the student every few seconds.
      setMessages((prev) => (sameConversation(prev, body.messages) ? prev : body.messages));
    };

    const timer = setInterval(() => void pull(), 4000);
    // Coming back to the window is the moment it most obviously matters, and
    // waiting out the interval there is the difference people notice.
    const onFocus = () => void pull();
    window.addEventListener('focus', onFocus);

    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [agentId, sending]);

  /*
   * Whether this conversation has anything in flight. `sending` is a turn this
   * page started; `pending` is one it found already running.
   */
  const working = sending || pending;
  useReportWorking(working);

  /*
   * What the line says, and when it changes.
   *
   * Once per step, not on a timer: the phrase is chosen to suit the work, so
   * changing it while the work has not changed would be saying something new
   * about nothing new. A minute spent on one tool holds one phrase, and the
   * mark beside it is what shows the turn is still alive.
   */
  const [phrase, setPhrase] = useState(() => pickPhrase(undefined));
  useEffect(() => {
    if (!working) return;
    setPhrase((current) => pickPhrase(activity, { avoid: [current] }));
  }, [working, activity]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;

    setDraft('');
    setSending(true);
    setError(null);

    // Optimistic: the turn is not streamed and can take several seconds, so
    // the student's own message has to appear immediately or the app feels
    // broken. Replaced by the server's copy when the response lands.
    const pending: Message = {
      id: `pending-${Date.now()}`,
      agentId,
      role: 'user',
      content,
      toolsUsed: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, pending]);

    try {
      const res = await api.agents[':id'].messages.$post({
        param: { id: agentId },
        json: { content },
      });

      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        throw new Error(body.message ?? `Request failed (${res.status})`);
      }

      const data = await res.json();
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== pending.id),
        data.userMessage,
        data.assistantMessage,
      ]);
    } catch (cause) {
      setMessages((prev) => prev.filter((m) => m.id !== pending.id));
      setDraft(content);
      setError(cause instanceof Error ? cause.message : 'Unknown error');
    } finally {
      setSending(false);
    }
  }

  if (missing) {
    return (
      <>
        <div className="chat-header">
          <button className="quiet" onClick={onBack}>
            ← Agents
          </button>
        </div>
        <p className="muted">That agent doesn&apos;t exist, or isn&apos;t yours.</p>
      </>
    );
  }

  if (!agent) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="chat-header">
        <button className="quiet" onClick={onBack}>
          ← Agents
        </button>
        <strong>{agent.name}</strong>
        <AgentMemory agent={agent} onChange={setAgent} />
        <VaultBrowser agentId={agent.id} />
      </div>

      <div className="workspace">
        <div className="chat-column">
          <div className="messages">
            {messages.length === 0 && <p className="muted">Say something to get started.</p>}

            {messages.map((message) => (
              <div key={message.id} className={`message ${message.role}`}>
                {/*
                 * Only assistant text is parsed for links. What a student types
                 * is shown exactly as they typed it.
                 */}
                {message.role === 'assistant' ? (
                  <MessageText text={message.content} onPreview={setPreview} />
                ) : (
                  message.content
                )}
              </div>
            ))}

            {/*
              In the message flow, where the work was asked for. Renders
              nothing until this conversation's agent is actually driving a
              browser.
            */}
            <AgentSession agentId={agentId} working={sending} />

            {working && (
              /*
               * What it is doing, not just that it is doing something. A
               * minute of "Thinking" while a browser signs into a school
               * account reads as a hang; naming the site makes the same wait
               * legible, and naming the step does the same for the rest.
               *
               * The browser wins when there is one. A phrase is what the line
               * says when there is nothing specific to say, and "signing in to
               * veracross" is about as specific as this gets.
               */
              <div className="muted thinking">
                <LogoMark size={20} working />
                <span>
                  {session.active && session.portalId
                    ? `Signing in to ${session.portalId} and reading it…`
                    : phrase}
                </span>
              </div>
            )}
            <div ref={bottom} />
          </div>

          {error && <p className="muted">{error}</p>}

          <form className="composer" onSubmit={send}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`Message ${agent.name}`}
              disabled={sending}
            />
            <button className="primary" type="submit" disabled={sending || !draft.trim()}>
              Send
            </button>
          </form>
        </div>

        {preview && <FilePreview target={preview} onClose={() => setPreview(null)} />}
      </div>
    </>
  );
}
