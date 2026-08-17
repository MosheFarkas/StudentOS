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

interface Connection {
  group: Group;
  name: string;
  blurb: string;
  /** The write half, where one exists. */
  sub?: { name: string; blurb: string };
}

const CONNECTIONS: Connection[] = [
  {
    group: 'calendar',
    name: 'Calendar',
    blurb: 'Plan around your real schedule, and add events when you ask.',
  },
  {
    group: 'classroom',
    name: 'Classroom',
    blurb: 'Your classes, assignments, due dates, materials and announcements.',
    sub: {
      name: 'Turning work in',
      blurb: 'Hand in and take back assignments, and attach files. Always asks first.',
    },
  },
  {
    group: 'drive',
    name: 'Drive',
    blurb: 'Read your documents, slides, PDFs and photographed worksheets.',
  },
  {
    group: 'gmail',
    name: 'Gmail',
    blurb: 'Read your email and attachments, and keep your inbox tidy.',
    sub: {
      name: 'Sending email',
      blurb: 'Send and reply as you. Shows you every message first, and never sends on its own.',
    },
  },
];

/**
 * Google connections.
 *
 * Two levels. An integration is the thing itself; beneath it sits the half
 * that WRITES -- turning work in, sending mail -- because those deserve to be
 * visible and switchable on their own.
 *
 * A parent carries its child: switching Gmail off takes sending with it,
 * since "can send email" left showing as on under a disabled Gmail is a lie
 * about the state of the system. Switching the child alone changes only the
 * child, so a student can read their mail while the agent cannot send any.
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

  async function connect(group: Group | 'all') {
    setBusy(group);
    setError(null);
    try {
      // The server decides the scope list, because it has to include what is
      // already granted -- see lib/auth.ts.
      const res = await api.google['connect-scopes'][':group'].$get({
        param: { group },
        query: {},
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

  async function toggle(key: string, enabled: boolean) {
    // Optimistic, and it mirrors the server's parent/child rule so the two
    // switches never disagree for the length of a round trip.
    setStatus((prev) => {
      if (!prev) return prev;
      const affected = key.includes(':') ? [key] : [key, `${key}:write`];
      return {
        ...prev,
        disabled: enabled
          ? prev.disabled.filter((d) => !affected.includes(d))
          : [...new Set([...prev.disabled, ...affected])],
      };
    });
    setError(null);

    const res = await api.google.integrations[':group'].$put({
      param: { group: key },
      json: { enabled },
    });
    if (!res.ok) {
      setError('Could not save that change.');
      void load();
    }
  }

  if (!status) return null;

  const isOn = (key: string) => !status.disabled.includes(key);
  const connected = CONNECTIONS.filter((c) => status[c.group]);
  const allConnected = connected.length === CONNECTIONS.length;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Connections</h2>
        <p className="muted">
          What your agent can see and do. Connect everything for the full thing, or pick what you
          want &mdash; you can switch any of it off later.
        </p>
      </div>

      {/*
       * One tap for the whole product, before the list of parts. Someone
       * setting this up for the first time wants their agent to work, not to
       * make four separate permission decisions before it does anything.
       */}
      {!allConnected && (
        <div className="connect-all">
          <div className="row-main">
            <strong>Connect everything</strong>
            <span className="badge">Recommended</span>
            <br />
            <span className="muted">
              Calendar, Classroom, Drive and Gmail in one step, so your agent knows your coursework
              from the start.
            </span>
          </div>
          <button className="primary" disabled={busy !== null} onClick={() => void connect('all')}>
            {busy === 'all' ? 'Opening…' : 'Connect'}
          </button>
        </div>
      )}

      {CONNECTIONS.map(({ group, name, blurb, sub }) => {
        const parentOn = isOn(group);
        return (
          <div key={group}>
            <div className="row static">
              <span className="row-main">
                <strong>{name}</strong>
                <br />
                <span className="muted">{blurb}</span>
              </span>

              <span className="row-control">
                {status[group] ? (
                  <>
                    <span className={parentOn ? 'status' : 'status off'}>
                      {parentOn ? 'On' : 'Off'}
                    </span>
                    <Toggle
                      label={`${name} enabled`}
                      checked={parentOn}
                      onChange={(next) => void toggle(group, next)}
                    />
                  </>
                ) : (
                  <button disabled={busy !== null} onClick={() => void connect(group)}>
                    {busy === group ? 'Opening…' : 'Connect'}
                  </button>
                )}
              </span>
            </div>

            {/*
             * The write half, shown only once the integration is connected.
             * Disabled rather than hidden when the parent is off, so the
             * setting stays visible and its state is obvious.
             */}
            {sub && status[group] && (
              <div className="row static sub">
                <span className="row-main">
                  <strong>{sub.name}</strong>
                  <br />
                  <span className="muted">{sub.blurb}</span>
                </span>
                <span className="row-control">
                  <span className={parentOn && isOn(`${group}:write`) ? 'status' : 'status off'}>
                    {parentOn && isOn(`${group}:write`) ? 'On' : 'Off'}
                  </span>
                  <Toggle
                    label={`${sub.name} enabled`}
                    checked={parentOn && isOn(`${group}:write`)}
                    disabled={!parentOn}
                    onChange={(next) => void toggle(`${group}:write`, next)}
                  />
                </span>
              </div>
            )}
          </div>
        );
      })}

      {/*
       * Partial approval is a NORMAL state on a school account, not an error.
       * Naming what is missing is the difference between "this is broken" and
       * "my school didn't approve that part".
       */}
      {status.classroom && status.missing.classroom.length > 0 && (
        <p className="muted">
          Your school hasn&apos;t approved everything for Classroom, so some of it won&apos;t work.
        </p>
      )}

      {!status.classroom && (
        <p className="muted">
          On a school account, Classroom may need an administrator to approve ContextoAgent first.
          Everything else works either way.
        </p>
      )}

      {error && <p className="muted">{error}</p>}
    </div>
  );
}
