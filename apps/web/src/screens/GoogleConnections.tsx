import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { connectGoogleScopes } from '../lib/auth.js';
import { Toggle } from './Toggle.js';

type Group = 'calendar' | 'classroom' | 'drive' | 'gmail';

type Status = {
  calendar: boolean;
  classroom: boolean;
  drive: boolean;
  gmail: boolean;
  classroomWrite: boolean;
  gmailWrite: boolean;
  disabled: string[];
  missing: { calendar: string[]; classroom: string[]; gmail: string[] };
};

/** Turn a scope URL into something a student can act on. */
const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly': 'assignments and due dates',
  'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly': 'your submissions',
  'https://www.googleapis.com/auth/classroom.announcements.readonly': 'class announcements',
  'https://www.googleapis.com/auth/classroom.topics.readonly': 'class topics',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly': 'class materials',
  'https://www.googleapis.com/auth/gmail.labels': 'your mail labels',
};

function describeMissing(scopes: string[]): string {
  return scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(', ');
}

const CONNECTIONS: { group: Group; name: string; blurb: string }[] = [
  {
    group: 'calendar',
    name: 'Calendar',
    blurb: 'Plan around your real schedule, and add events when you ask.',
  },
  {
    group: 'classroom',
    name: 'Classroom',
    blurb: 'Your classes, assignments, due dates, materials and announcements.',
  },
  {
    group: 'drive',
    name: 'Drive',
    blurb: 'Read your documents, slides, PDFs and photographed worksheets.',
  },
  {
    group: 'gmail',
    name: 'Gmail',
    blurb: 'Read your email and attachments. This is your whole mailbox.',
  },
];

/**
 * Google connections.
 *
 * Each integration is a separate consent, asked for only when a student
 * chooses it -- never bundled into sign-in. Beyond converting better, that
 * separation is what lets someone who cannot get Classroom approved still use
 * everything else.
 *
 * Once connected the control becomes a switch rather than a disconnect
 * button. Turning something off should be instant and reversible; making a
 * student walk back through Google's consent screen to undo a tap punishes
 * them for changing their mind.
 */
export function GoogleConnections() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await api.google.status.$get();
    if (res.ok) setStatus((await res.json()) as Status);
  }

  useEffect(() => {
    void load();
  }, []);

  async function connect(group: Group, elective = false) {
    setBusy(group);
    setError(null);
    try {
      // The server decides the scope list, because it has to include what is
      // already granted -- see lib/auth.ts.
      const res = await api.google['connect-scopes'][':group'].$get({
        param: { group },
        query: elective ? { elective: 'true' } : {},
      });
      if (!res.ok) throw new Error('Could not work out which permissions to request.');

      const body = await res.json();
      if (!('scopes' in body)) throw new Error('Unexpected response.');

      // Redirects to Google. Execution stops here on success.
      await connectGoogleScopes(body.scopes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
      setBusy(null);
    }
  }

  async function toggle(group: Group, enabled: boolean) {
    // Optimistic: a switch that waits on a round trip feels broken.
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            disabled: enabled
              ? prev.disabled.filter((g) => g !== group)
              : [...prev.disabled, group],
          }
        : prev,
    );
    setError(null);

    const res = await api.google.integrations[':group'].$put({
      param: { group },
      json: { enabled },
    });
    if (!res.ok) {
      setError('Could not save that change.');
      void load();
    }
  }

  if (!status) return null;

  const isOn = (group: Group) => !status.disabled.includes(group);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Connections</h2>
        <p className="muted">
          Connect only what you want your agent to use. Each one is separate, and you can switch any
          of them off at any time.
        </p>
      </div>

      {CONNECTIONS.map(({ group, name, blurb }) => (
        <div className="row static" key={group}>
          <span className="row-main">
            <strong>{name}</strong>
            <br />
            <span className="muted">{blurb}</span>
          </span>

          <span className="row-control">
            {status[group] ? (
              <>
                <span className={isOn(group) ? 'status' : 'status off'}>
                  {isOn(group) ? 'On' : 'Off'}
                </span>
                <Toggle
                  label={`${name} enabled`}
                  checked={isOn(group)}
                  onChange={(next) => void toggle(group, next)}
                />
              </>
            ) : (
              <button
                className="primary"
                disabled={busy !== null}
                onClick={() => void connect(group)}
              >
                {busy === group ? 'Opening…' : 'Connect'}
              </button>
            )}
          </span>
        </div>
      ))}

      {/*
       * Partial approval is a NORMAL state on a school account, not an error.
       * Naming what is missing is the difference between "this product is
       * broken" and "my school didn't approve that part".
       */}
      {status.classroom && status.missing.classroom.length > 0 && (
        <p className="muted">
          Your school hasn&apos;t approved everything for Classroom: your agent can&apos;t see{' '}
          {describeMissing(status.missing.classroom)}.
        </p>
      )}

      {!status.classroom && (
        <p className="muted">
          On a school Google account, Classroom may need an administrator to approve ContextoAgent
          first. Everything else works either way.
        </p>
      )}

      {/* Writing is always a second, explicit decision. Reading never implies it. */}
      {((status.classroom && !status.classroomWrite) ||
        (status.gmail && !status.gmailWrite) ||
        status.gmailWrite) && <hr />}

      {status.classroom && !status.classroomWrite && (
        <div className="row static">
          <span className="row-main">
            <strong>Let your agent turn work in</strong>
            <br />
            <span className="muted">
              Hand in and take back assignments, and attach files to them. It asks first.
            </span>
          </span>
          <button disabled={busy !== null} onClick={() => void connect('classroom', true)}>
            {busy === 'classroom' ? 'Opening…' : 'Allow'}
          </button>
        </div>
      )}

      {status.gmail && !status.gmailWrite && (
        <div className="row static">
          <span className="row-main">
            <strong>Let your agent write email</strong>
            <br />
            <span className="muted">
              Send and reply, archive, label, and move mail to Trash. It shows you every email
              before sending, and can never delete mail permanently.
            </span>
          </span>
          <button disabled={busy !== null} onClick={() => void connect('gmail', true)}>
            {busy === 'gmail' ? 'Opening…' : 'Allow'}
          </button>
        </div>
      )}

      {status.gmailWrite && (
        <p className="muted">
          Your agent can send email as you. It asks first, and it will never send because an email
          it read told it to.
        </p>
      )}

      {error && <p className="muted">{error}</p>}
    </div>
  );
}
