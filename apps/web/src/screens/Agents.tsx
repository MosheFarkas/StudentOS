import { useEffect, useState } from 'react';
import type { Agent } from '@contexto/shared';
import { api } from '../lib/api.js';

interface Props {
  onOpen: (agent: Agent) => void;
}

export function Agents({ onOpen }: Props) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const res = await api.agents.$get();
      if (!res.ok) throw new Error(`Failed to load agents (${res.status})`);
      const data = await res.json();
      setAgents(data.agents);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (error) return <p className="muted">{error}</p>;
  if (!agents) return <p className="muted">Loading…</p>;

  return (
    <>
      {agents.length === 0 && !creating && (
        <div className="panel">
          <p>You haven&apos;t built an agent yet.</p>
          <button onClick={() => setCreating(true)}>Build your first agent</button>
        </div>
      )}

      {creating && (
        <CreateAgent
          onCancel={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            onOpen(agent);
          }}
        />
      )}

      {agents.map((agent) => (
        <button key={agent.id} className="row" onClick={() => onOpen(agent)}>
          <strong>{agent.name}</strong>
          <span className="muted">{agent.purpose}</span>
        </button>
      ))}

      {agents.length > 0 && !creating && (
        <button style={{ marginTop: '1rem' }} onClick={() => setCreating(true)}>
          New agent
        </button>
      )}
    </>
  );
}

/**
 * Agent creation.
 *
 * Two plain-language fields, no prompt box. The product thesis is that a
 * student who has never written a prompt can build something useful, so the
 * form asks what they want it to do -- the system prompt is assembled from
 * this in packages/agent/src/run.ts and never shown.
 */
function CreateAgent({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (agent: Agent) => void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const res = await api.agents.$post({ json: { name, purpose } });
      if (!res.ok) throw new Error(`Could not create agent (${res.status})`);
      const data = await res.json();
      onCreated(data.agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
      setSaving(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <label>
        What should we call it?
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Study buddy"
          maxLength={80}
          required
        />
      </label>

      <label>
        What should it help you with?
        <textarea
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="Keep track of my assignments and remind me what's due. Help me plan study sessions around my class schedule."
          rows={4}
          maxLength={2000}
          required
        />
      </label>

      {error && <p className="muted">{error}</p>}

      <div className="actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Creating…' : 'Create'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
