import { useEffect, useRef, useState } from 'react';
import type { Agent, Message } from '@contexto/shared';
import { api } from '../lib/api.js';
import type { PreviewTarget } from '../lib/preview.js';
import { FilePreview } from './FilePreview.js';
import { MessageText } from './MessageText.js';

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
      if (history.ok) setMessages((await history.json()).messages);
    })();
  }, [agentId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

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
          <button onClick={onBack}>← Agents</button>
        </div>
        <p className="muted">That agent doesn&apos;t exist, or isn&apos;t yours.</p>
      </>
    );
  }

  if (!agent) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="chat-header">
        <button onClick={onBack}>← Agents</button>
        <strong>{agent.name}</strong>
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
                {message.toolsUsed.length > 0 && (
                  <span className="muted tools">used {message.toolsUsed.join(', ')}</span>
                )}
              </div>
            ))}

            {sending && <p className="muted">Thinking…</p>}
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
            <button type="submit" disabled={sending || !draft.trim()}>
              Send
            </button>
          </form>
        </div>

        {preview && <FilePreview target={preview} onClose={() => setPreview(null)} />}
      </div>
    </>
  );
}
