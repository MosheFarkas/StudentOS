import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Everything the agent knows about a student's school, for the student.
 *
 * The memory panel shows the profile, which is a paragraph anybody can read in
 * fifteen seconds. The vault is hundreds of notes -- their courses, their
 * assignments, their teachers, and a record of what happened -- and until there
 * was a way to look at it they were being asked to trust a filing cabinet
 * nobody had ever opened.
 *
 * Two levels and no more. What is in there, and then one thing and its history.
 * A graph view is the obvious next thought and the wrong first one: a student
 * wants to know what their agent thinks about the Cold War essay, not to
 * navigate a network.
 */

interface Group {
  kind: string;
  notes: { name: string; description: string }[];
}

interface Note {
  name: string;
  kind: string;
  source: string;
  description: string;
  body: string;
  occurred: string | null;
  actor: string | null;
  event: string | null;
  sourceUrl: string | null;
}

interface TimelineEntry {
  name: string;
  description: string;
  source: string;
  occurred: string | null;
  actor: string | null;
  event: string | null;
}

/** Turn a note name back into something a person would read. */
function readable(name: string): string {
  return name.replaceAll('-', ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** `assignment-graded` reads as machinery. "Graded" does not. */
function eventLabel(event: string | null): string {
  if (!event) return '';
  return event.replace(/^assignment-/, '').replaceAll('-', ' ');
}

function when(occurred: string | null): string {
  if (!occurred) return '';
  const date = new Date(occurred);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function VaultBrowser({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [episodes, setEpisodes] = useState(0);
  const [selected, setSelected] = useState<{ note: Note; timeline: TimelineEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || groups) return;
    void (async () => {
      const res = await api.agents[':id'].vault.$get({ param: { id: agentId } });
      if (!res.ok) {
        setError('That could not be loaded.');
        return;
      }
      const body = await res.json();
      setGroups(body.groups);
      setEpisodes(body.episodes);
    })();
  }, [open, groups, agentId]);

  async function openNote(name: string) {
    setError(null);
    const res = await api.agents[':id'].vault[':name'].$get({ param: { id: agentId, name } });
    if (!res.ok) {
      setError('That note could not be opened.');
      return;
    }
    setSelected(await res.json());
  }

  if (!open) {
    return (
      <button className="quiet" onClick={() => setOpen(true)}>
        What it knows about school
      </button>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{selected ? readable(selected.note.name) : 'What it knows about school'}</h2>
        {selected ? (
          <button className="quiet" onClick={() => setSelected(null)}>
            ← Back
          </button>
        ) : (
          <button className="quiet" onClick={() => setOpen(false)}>
            Close
          </button>
        )}
      </div>

      {error && <p className="muted">{error}</p>}

      {selected ? (
        <>
          <p className="muted">
            {selected.note.source === 'student'
              ? 'From your own conversations.'
              : `From ${selected.note.source}.`}
            {selected.note.actor ? ` ${selected.note.actor}.` : ''}
            {when(selected.note.occurred) ? ` ${when(selected.note.occurred)}.` : ''}
          </p>

          <pre className="note-body">{selected.note.body}</pre>

          {selected.timeline.length > 0 && (
            <>
              <h3>What happened</h3>
              {selected.timeline.map((entry) => (
                <button key={entry.name} className="row" onClick={() => void openNote(entry.name)}>
                  <span>{entry.description || readable(entry.name)}</span>
                  <span className="muted">
                    {[when(entry.occurred), eventLabel(entry.event)].filter(Boolean).join(' · ')}
                  </span>
                </button>
              ))}
            </>
          )}
        </>
      ) : !groups ? (
        <p className="muted">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="muted">
          Nothing yet. It fills in once you connect Google and it has read your Classroom.
        </p>
      ) : (
        <>
          <p className="muted">
            {groups.reduce((n, group) => n + group.notes.length, 0)} things, and {episodes} records
            of what happened. It wrote all of this from your own school accounts.
          </p>
          {groups.map((group) => (
            <div key={group.kind}>
              <h3>{group.kind}s</h3>
              {group.notes.map((note) => (
                <button key={note.name} className="row" onClick={() => void openNote(note.name)}>
                  <span>{readable(note.name)}</span>
                </button>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
