import { useState } from 'react';
import type { Agent } from '@contexto/shared';
import { api } from '../lib/api.js';

/**
 * What the agent thinks it knows about you, and the ability to correct it.
 *
 * This document is written by a background job from the student's own
 * conversations and then sits in the system prompt of every future one, which
 * means a line that is wrong is quietly wrong for ever. Nothing else in the
 * product is like that: a bad answer is visible and forgotten, a bad memory is
 * invisible and permanent.
 *
 * So it is shown in the student's own words rather than summarised, and the
 * destructive option is offered plainly rather than buried. "Forget this" is
 * the reason to open the panel at all.
 */

const LIMIT = 1400;

interface Props {
  agent: Agent;
  onChange: (agent: Agent) => void;
}

export function AgentMemory({ agent, onChange }: Props) {
  /*
   * Defaulted rather than assumed present.
   *
   * This renders inside the chat header, so a missing string does not degrade
   * the panel -- it takes down the conversation view with it. An agent
   * serialised before this field existed, or a cached response from one, is
   * enough to do it.
   */
  const profile = agent.profile ?? '';

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(profile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = draft.trim() !== profile.trim();

  async function save(next: string) {
    setSaving(true);
    setError(null);
    const res = await api.agents[':id'].profile.$patch({
      param: { id: agent.id },
      json: { profile: next },
    });
    setSaving(false);

    if (!res.ok) {
      setError('That could not be saved. Try again in a moment.');
      return;
    }
    const body = await res.json();
    onChange(body.agent);
    setDraft(body.agent.profile ?? '');
  }

  if (!open) {
    return (
      <button className="quiet" onClick={() => setOpen(true)}>
        What it knows about you
      </button>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>What it knows about you</h2>
        <button className="quiet" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {profile === '' ? (
        <p className="muted">
          Nothing yet. It writes this down after a few conversations, from what you tell it.
        </p>
      ) : (
        <p className="muted">
          It wrote this itself, from your conversations. Change anything that is wrong, or clear it
          and it will start again.
        </p>
      )}

      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value.slice(0, LIMIT))}
        rows={7}
        placeholder="Nothing yet."
        aria-label="What the agent knows about you"
      />

      <p className="muted">
        {draft.length} of {LIMIT} characters
      </p>

      {error && <p className="muted">{error}</p>}

      <div className="actions">
        <button disabled={!dirty || saving} onClick={() => void save(draft.trim())}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="danger"
          disabled={saving || profile === ''}
          onClick={() => void save('')}
        >
          Forget all of it
        </button>
      </div>
    </div>
  );
}
