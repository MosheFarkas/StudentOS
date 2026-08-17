import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { connectGoogleScopes } from '../lib/auth.js';
import { pickDriveFiles, pickerConfigured } from '../lib/picker.js';

/**
 * Files the agent is allowed to read.
 *
 * The mental model this screen has to establish: connecting Drive grants
 * NOTHING. Access is per file, and the student gives it one file at a time.
 * A student who reads "Drive: Connected" and then hears "I can't read that"
 * will reasonably conclude the product is broken, so the copy here leads with
 * the per-file rule rather than burying it.
 */
export function DriveFiles() {
  const [connected, setConnected] = useState(false);
  const [broadAccess, setBroadAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await api.google.drive.files.$get();
    if (!res.ok) return;
    const body = await res.json();
    setConnected(body.connected);
    setBroadAccess('broadAccess' in body ? Boolean(body.broadAccess) : false);
  }

  useEffect(() => {
    void load();
  }, []);

  /** `elective` asks Google for full-Drive read as well as per-file access. */
  async function connect(elective: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.google['connect-scopes'][':group'].$get({
        param: { group: 'drive' },
        query: elective ? { elective: 'true' } : {},
      });
      if (!res.ok) throw new Error('Could not work out which permissions to request.');

      const body = await res.json();
      if (!('scopes' in body)) throw new Error('Unexpected response.');

      // Redirects to Google. Execution stops here on success.
      await connectGoogleScopes(body.scopes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
      setBusy(false);
    }
  }

  async function addFiles() {
    setBusy(true);
    setError(null);
    try {
      await pickDriveFiles();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  // Nothing to say until Drive is connected; the switch for that lives with
  // the other connections above.
  if (!connected) return null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Files</h2>
        <p className="muted">
          {broadAccess
            ? 'Your agent can read any file in your Drive, including everything your teachers post to Classroom.'
            : 'Your agent can only read files you hand it. Nothing else in your Drive is visible.'}
        </p>
      </div>

      {broadAccess ? (
        <div className="row static">
          <span className="row-main">
            <strong>Whole Drive</strong>
            <br />
            <span className="muted">No picking needed.</span>
          </span>
          <span className="status">On</span>
        </div>
      ) : (
        <>
          <div className="row static">
            <span className="row-main">
              <strong>Files you choose</strong>
              <br />
              <span className="muted">
                Pick documents or a whole folder. Teacher-posted materials are under{' '}
                <em>Shared with me</em>.
              </span>
            </span>
            {pickerConfigured() && (
              <button disabled={busy} onClick={() => void addFiles()}>
                {busy ? 'Opening…' : 'Add files'}
              </button>
            )}
          </div>

          {/*
           * Deployment config, not a student error -- but without saying so
           * they see a connection with no way to use it.
           */}
          {!pickerConfigured() && (
            <p className="muted">
              File picking isn&apos;t set up for this deployment yet (VITE_GOOGLE_CLIENT_ID and
              VITE_GOOGLE_PICKER_API_KEY).
            </p>
          )}

          <div className="row static">
            <span className="row-main">
              <strong>Whole Drive instead</strong>
              <br />
              <span className="muted">
                Skip picking entirely. Google shows an &quot;unverified app&quot; warning, and a
                school account may have this blocked.
              </span>
            </span>
            <button disabled={busy} onClick={() => void connect(true)}>
              {busy ? 'Opening…' : 'Allow'}
            </button>
          </div>
        </>
      )}

      {error && <p className="muted">{error}</p>}
    </div>
  );
}
