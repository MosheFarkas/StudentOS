import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { connectGoogleScopes } from '../lib/auth.js';
import { pickDriveFiles, pickerConfigured } from '../lib/picker.js';

interface DriveFile {
  fileId: string;
  name: string;
  kind: string;
}

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
  const [files, setFiles] = useState<DriveFile[] | null>(null);
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
    setFiles(('files' in body ? (body.files as DriveFile[]) : []) ?? []);
    if ('error' in body && typeof body.error === 'string') setError(body.error);
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
      // Reload unconditionally. Cancelling returns an empty list, and the
      // list can still have changed in another tab.
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Files</h2>
      <p className="muted">
        {broadAccess
          ? 'Your agent can read any file in your Drive, including Classroom materials.'
          : 'Your agent can read the files you add here — Google Docs, Slides, Sheets, PDFs, and text. It can’t see anything else in your Drive.'}
      </p>

      {!connected ? (
        /*
         * Both grants are offered HERE, at the moment of connecting.
         *
         * They were not, and that was a real failure: the only button on this
         * branch granted per-file access, and the broader option lived inside
         * the already-connected branch below. A student who wanted their agent
         * to just read their files had no way to say so, connected, and then
         * got told to attach files one at a time -- which is the exact
         * friction they were trying to avoid.
         */
        <>
          <div className="row static">
            <span>
              <strong>Files I pick</strong>
              <br />
              <span className="muted">
                You choose which files or folders. Nothing else is visible.
              </span>
            </span>
            <button disabled={busy} onClick={() => void connect(false)}>
              {busy ? 'Opening…' : 'Connect'}
            </button>
          </div>

          <div className="row static">
            <span>
              <strong>My whole Drive</strong>
              <br />
              <span className="muted">
                No picking — your agent can read any file, Classroom materials included.
              </span>
            </span>
            <button disabled={busy} onClick={() => void connect(true)}>
              {busy ? 'Opening…' : 'Connect'}
            </button>
          </div>

          <p className="muted">
            Whole-Drive access shows an &quot;unverified app&quot; warning from Google, and a school
            account may have it blocked by an administrator. You can change either one later.
          </p>
        </>
      ) : (
        <>
          <div className="row static">
            <span className="status">{broadAccess ? 'Full Drive access' : 'Connected'}</span>
            {pickerConfigured() && !broadAccess && (
              <button disabled={busy} onClick={() => void addFiles()}>
                {busy ? 'Opening…' : 'Add files'}
              </button>
            )}
          </div>

          {/*
           * Deployment config, not a user error -- but without saying so the
           * student sees a connected integration with no way to use it.
           */}
          {!pickerConfigured() && !broadAccess && (
            <p className="muted">
              File picking isn&apos;t set up for this deployment yet (VITE_GOOGLE_CLIENT_ID and
              VITE_GOOGLE_PICKER_API_KEY).
            </p>
          )}

          {!broadAccess && files && files.length === 0 && (
            <p className="muted">
              No files yet. Use <strong>Add files</strong> — you can select several at once, or a
              whole folder. Teacher-posted materials are under <em>Shared with me</em>.
            </p>
          )}

          {files?.map((file) => (
            <div key={file.fileId} className="row static">
              <span>
                <strong>{file.name}</strong>
                <br />
                <span className="muted">{file.kind}</span>
              </span>
            </div>
          ))}

          {/*
           * The upgrade, stated plainly rather than sold. Picking files one at
           * a time is genuinely tedious, and a student who would rather hand
           * over everything should be able to -- but "everything" means
           * everything, so it says so before they click, not after.
           */}
          {!broadAccess && (
            <>
              <hr />
              <p className="muted">
                {files && files.length === 0
                  ? 'Rather not pick files at all? Give your agent read access to your whole Drive instead — every file, Classroom materials included.'
                  : 'You can also give your agent read access to your whole Drive, so you never need to add files individually.'}{' '}
                Google will show an &quot;unverified app&quot; warning, and on a school account an
                administrator may block it.
              </p>
              <button disabled={busy} onClick={() => void connect(true)}>
                {busy ? 'Opening…' : 'Give access to all my Drive'}
              </button>
            </>
          )}
        </>
      )}

      {error && <p className="muted">{error}</p>}
    </div>
  );
}
