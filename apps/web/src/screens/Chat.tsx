import { useEffect, useRef, useState } from 'react';
import type { Agent, Message } from '@studentos/shared';
import { api } from '../lib/api.js';

interface Props {
  agent: Agent;
  onBack: () => void;
}

export function Chat({ agent, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.agents[':id'].messages.$get({ param: { id: agent.id } });
      if (res.ok) setMessages((await res.json()).messages);
    })();
  }, [agent.id]);

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
      agentId: agent.id,
      role: 'user',
      content,
      toolsUsed: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, pending]);

    try {
      const res = await api.agents[':id'].messages.$post({
        param: { id: agent.id },
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

  return (
    <>
      <div className="chat-header">
        <button onClick={onBack}>← Agents</button>
        <strong>{agent.name}</strong>
      </div>

      <div className="messages">
        {messages.length === 0 && <p className="muted">Say something to get started.</p>}

        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.content}
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
    </>
  );
}
