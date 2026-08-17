import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { connectGoogleScopes } from '../lib/auth.js';

type Status = {
  calendar: boolean;
  classroom: boolean;
  classroomWrite: boolean;
  gmail: boolean;
  gmailWrite: boolean;
  missing: { calendar: string[]; classroom: string[] };
};
type Group = 'calendar' | 'classroom' | 'gmail';

/** Turn a scope URL into something a student can act on. */
const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly': 'assignments and due dates',
  'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly': 'your submissions',
  'https://www.googleapis.com/auth/classroom.announcements.readonly': 'class announcements',
  'https://www.googleapis.com/auth/classroom.topics.readonly': 'class topics',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly': 'class materials',
};

function describeMissing(scopes: string[]): string {
  return scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(', ');
}

/**
 * Google connections.
 *
 * Calendar and Classroom are separate, optional grants, asked for only when
 * the student chooses them -- never bundled into the sign-in consent screen.
 * Beyond converting better, that separation is what lets a student who cannot
 * get Classroom approved still use everything else.
 */
export function GoogleConnections() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<Group | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await api.google.status.$get();
    if (res.ok) setStatus(await res.json());
  }

  useEffect(() => {
    void load();
  }, []);

  async function connect(group: Group, elective = false) {
    setBusy(group);
    setError(null);

    try {
      // The server decides the scope list, because it has to include what is
      // already granted -- see lib/auth.ts. `elective` adds the group's
      // opt-in scopes on top, which for Classroom means turning work in.
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

  if (!status) return null;

  return (
    <div className="panel">
      <h2>Google</h2>
      <p className="muted">
        Connect only what you want your agent to see. You can do these separately.
      </p>

      <div className="row static">
        <span>
          <strong>Calendar</strong>
          <br />
          <span className="muted">Lets your agent plan around your actual schedule.</span>
        </span>
        {status.calendar ? (
          <span className="status">Connected</span>
        ) : (
          <button disabled={busy !== null} onClick={() => void connect('calendar')}>
            {busy === 'calendar' ? 'Opening…' : 'Connect'}
          </button>
        )}
      </div>

      <div className="row static">
        <span>
          <strong>Classroom</strong>
          <br />
          <span className="muted">Assignments and due dates, if your school allows it.</span>
        </span>
        {status.classroom ? (
          <span className="status">Connected</span>
        ) : (
          <button disabled={busy !== null} onClick={() => void connect('classroom')}>
            {busy === 'classroom' ? 'Opening…' : 'Connect'}
          </button>
        )}
      </div>

      {/*
       * Connected but partial. School admins approve scope subsets routinely,
       * so this is a normal state -- and naming what is missing is the
       * difference between "the product is broken" and "my school didn't
       * approve that bit".
       */}
      {status.classroom && status.missing.classroom.length > 0 && (
        <p className="muted">
          Your school hasn&apos;t approved everything: your agent can&apos;t see{' '}
          {describeMissing(status.missing.classroom)}. Courses still work.
        </p>
      )}

      {/*
       * Turning work in is off unless asked for, and stays a separate decision
       * from connecting Classroom. It is the student's name on a submission,
       * so it should never arrive as a side effect of connecting to read.
       */}
      {status.classroom && !status.classroomWrite && (
        <div className="row static">
          <span>
            <strong>Let your agent turn work in</strong>
            <br />
            <span className="muted">
              Hand in and take back assignments, and attach files to them.
            </span>
          </span>
          <button disabled={busy !== null} onClick={() => void connect('classroom', true)}>
            {busy === 'classroom' ? 'Opening…' : 'Allow'}
          </button>
        </div>
      )}

      {status.classroomWrite && (
        <p className="muted">
          Your agent can turn work in. It will ask you before submitting anything.
        </p>
      )}

      {/*
       * Mail is its own connection, and deliberately last. It is the most
       * invasive thing here -- there is no "only school mail" scope, so it is
       * the whole mailbox -- and a student should be able to have Classroom
       * and Calendar without ever being nudged into this one.
       */}
      <div className="row static">
        <span>
          <strong>Gmail</strong>
          <br />
          <span className="muted">
            Lets your agent read your email and attachments. This is your whole mailbox &mdash;
            Google has no way to share only school mail.
          </span>
        </span>
        {status.gmail ? (
          <span className="status">Connected</span>
        ) : (
          <button disabled={busy !== null} onClick={() => void connect('gmail')}>
            {busy === 'gmail' ? 'Opening…' : 'Connect'}
          </button>
        )}
      </div>

      {status.gmail && !status.gmailWrite && (
        <div className="row static">
          <span>
            <strong>Let your agent write email</strong>
            <br />
            <span className="muted">
              Send and reply, archive, label, and move mail to Trash. It will always show you an
              email and ask before sending it.
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
          it read told it to. It cannot delete mail permanently &mdash; only move it to Trash.
        </p>
      )}

      {!status.classroom && (
        /*
         * Set expectations before the student hits the wall rather than after.
         * On a school-managed account this is very often blocked by an admin,
         * and a student who tries and fails with no explanation concludes the
         * product is broken.
         */
        <p className="muted">
          If you use a school Google account, Classroom may need an administrator to approve
          Contexto first. Everything else works either way.
        </p>
      )}

      {error && <p className="muted">{error}</p>}
    </div>
  );
}
