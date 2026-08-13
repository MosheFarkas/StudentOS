import { useEffect, useState } from 'react';
import type { Agent } from '@studentos/shared';
import { api } from '../lib/api.js';

type Link = { channel: string; agentId: string };

/**
 * Telegram linking.
 *
 * The code is the whole security model: the webhook is a public endpoint, so
 * identity has to be proven by something only someone inside an authenticated
 * session can see. Hence a short-lived code rather than "enter your username".
 */
export function TelegramConnection() {
  const [available, setAvailable] = useState(false);
  const [links, setLinks] = useState<Link[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [statusRes, agentsRes] = await Promise.all([
      api.channels.status.$get(),
      api.agents.$get(),
    ]);
    if (statusRes.ok) {
      const status = await statusRes.json();
      setAvailable(status.telegramAvailable);
      setLinks(status.links);
    }
    if (agentsRes.ok) {
      const list = (await agentsRes.json()).agents;
      setAgents(list);
      setSelectedAgent((current) => current || (list[0]?.id ?? ''));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Hidden entirely when the server has no bot configured, rather than shown
  // as a button that fails.
  if (!available) return null;

  const linked = links.find((l) => l.channel === 'telegram');

  async function requestCode() {
    setError(null);
    try {
      const res = await api.channels.telegram['link-code'].$post({
        json: { agentId: selectedAgent },
      });
      if (!res.ok) throw new Error('Could not create a code.');
      setCode(await res.json());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
    }
  }

  async function unlink() {
    await api.channels.telegram.link.$delete();
    setCode(null);
    void load();
  }

  return (
    <div className="panel">
      <h2>Telegram</h2>
      <p className="muted">
        Message your agent from your phone. It answers whether or not this page is open.
      </p>

      {linked ? (
        <div className="row static">
          <span className="muted">
            Connected to {agents.find((a) => a.id === linked.agentId)?.name ?? 'an agent'}
          </span>
          <button onClick={() => void unlink()}>Disconnect</button>
        </div>
      ) : agents.length === 0 ? (
        <p className="muted">Create an agent first, then connect Telegram to it.</p>
      ) : code ? (
        <>
          <p>
            Send this to the bot: <strong>/link {code.code}</strong>
          </p>
          <p className="muted">
            Expires {new Date(code.expiresAt).toLocaleTimeString()}. Message the bot on Telegram,
            then reload this page.
          </p>
        </>
      ) : (
        <>
          <label>
            Which agent should answer?
            <select value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => void requestCode()}>Get linking code</button>
        </>
      )}

      {error && <p className="muted">{error}</p>}
    </div>
  );
}
