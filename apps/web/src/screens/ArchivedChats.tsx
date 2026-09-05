import { useEffect, useState } from 'react';
import type { Agent } from '@contexto/shared';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { Row } from './SettingsRow.js';

/**
 * Chats the student has put away.
 *
 * Archiving hides a chat from the rail and does nothing else: the transcript
 * is intact, the memories are intact, and everything it taught chats.md is
 * still in there being read on every turn. So this list is the whole of what
 * archiving costs -- somewhere to find them again -- and it belongs in
 * settings rather than in the rail, which is the thing they were removed from.
 *
 * Renders nothing at all when there are none. An empty section headed
 * "Archived chats" invites a student to wonder what they have lost.
 */
export function ArchivedChats() {
  const [archived, setArchived] = useState<Agent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.agents.$get();
      if (!res.ok) return;
      const { agents } = await res.json();
      setArchived(agents.filter((chat) => chat.archivedAt !== null));
    })();
  }, []);

  async function restore(chat: Agent) {
    setBusy(chat.id);
    try {
      const res = await api.agents[':id'].$patch({
        param: { id: chat.id },
        json: { archived: false },
      });
      if (!res.ok) return;
      setArchived((prev) => prev.filter((c) => c.id !== chat.id));
    } finally {
      setBusy(null);
    }
  }

  if (archived.length === 0) return null;

  return (
    <>
      <h2 className="settings-heading">Archived chats</h2>
      <p className="settings-intro">
        Out of the rail, still in your vault. Everything these taught your agent is still
        remembered.
      </p>

      {archived.map((chat) => (
        <Row key={chat.id} label={chat.name} hint={`Archived ${when(chat.archivedAt)}`}>
          <button onClick={() => navigate({ name: 'chat', agentId: chat.id })}>Open</button>
          <button disabled={busy === chat.id} onClick={() => void restore(chat)}>
            {busy === chat.id ? 'Restoring…' : 'Restore'}
          </button>
        </Row>
      ))}
    </>
  );
}

/**
 * When it was put away, in the student's own locale.
 *
 * The date rather than "3 months ago": recognising a chat in a list of forty
 * is what this line is for, and a month is a better handle for that than an
 * elapsed count.
 */
function when(iso: string | null): string {
  if (!iso) return 'recently';
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? 'recently'
    : at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
