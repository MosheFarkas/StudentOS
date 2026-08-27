import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Building the vault, and saying how far along it is.
 *
 * The periodic refresh runs every six hours and deliberately not on startup,
 * so a student who has just connected their school meets an empty vault for
 * most of a day with nothing telling them anything is coming. This is the same
 * work with somebody's finger on it.
 *
 * A build is minutes long -- a model call per message, a model call per file --
 * so nothing here waits on it. The counts are polled while it runs, because
 * watching a number climb is the honest way to show work that has no
 * meaningful percentage.
 */

interface Progress {
  /*
   * A plain string, matching what the route sends. Narrowing it to a union
   * here would only be a second copy of a list the server already owns, and
   * the two would drift the first time a phase was added.
   */
  phase: string;
  done: number;
  total: number;
  startedAt: number;
}

interface Status {
  ready: boolean;
  missing: string[];
  entities: number;
  episodes: number;
  building: boolean;
  progress: Progress | null;
}

/*
 * The four phases, in the order they run, with what each is doing.
 *
 * They are wildly uneven -- on a real account the structure took twenty
 * seconds, the mail eight minutes and the files two hours -- so naming the
 * phase is most of what makes a two-hour wait legible.
 */
const PHASES: { key: string; label: string }[] = [
  { key: 'classroom', label: 'Reading your courses' },
  { key: 'drive', label: 'Finding your files' },
  { key: 'mail', label: 'Going through your school mail' },
  { key: 'files', label: 'Reading what is in each file' },
  { key: 'classes', label: 'Writing up each of your classes' },
];

/** "about 40 minutes left", from how long the work so far actually took. */
function timeLeft(at: Progress): string | null {
  if (at.done < 3 || at.total <= at.done) return null;
  const each = (Date.now() - at.startedAt) / at.done;
  const minutes = Math.round((each * (at.total - at.done)) / 60000);
  if (minutes < 1) return 'nearly done';
  if (minutes < 90) return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;
  return `about ${Math.round(minutes / 60)} hours left`;
}

/** Often enough to feel live, rarely enough to be free. */
const WHILE_BUILDING = 4000;

export function VaultBuild() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.vault.$get();
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Polled only while something is happening; a finished vault is not news.
  useEffect(() => {
    if (!status?.building) return;
    const timer = setInterval(() => void load(), WHILE_BUILDING);
    return () => clearInterval(timer);
  }, [status?.building, load]);

  async function build() {
    setError(null);
    const res = await api.vault.build.$post();
    if (!res.ok && res.status !== 409) {
      setError('That could not be started. Check your connections and try again.');
    }
    await load();
  }

  if (!status) return null;

  const total = status.entities + status.episodes;

  return (
    <div className="vault-build">
      <div className="vault-build-row">
        <span className="muted">
          {status.building
            ? `${total.toLocaleString()} notes so far`
            : total === 0
              ? 'Nothing in it yet.'
              : `${total.toLocaleString()} notes.`}
        </span>
        <button disabled={!status.ready || status.building} onClick={() => void build()}>
          {status.building ? 'Building…' : total === 0 ? 'Build vault' : 'Update vault'}
        </button>
      </div>

      {/*
       * A disabled button with no reason is the worst of both. If something is
       * missing, say which thing and where to fix it.
       */}
      {status.missing.length > 0 && (
        <p className="muted">
          {status.ready
            ? `Connect ${asList(status.missing)} below to include ${
                status.missing.length === 1 ? 'it' : 'them'
              } too.`
            : `Connect ${asList(status.missing)} below first — without Classroom there are no courses for anything else to be about.`}
        </p>
      )}

      {status.building && status.progress && (
        <div className="vault-progress">
          <ol className="vault-phases">
            {PHASES.map(({ key, label }) => {
              const at = PHASES.findIndex((p) => p.key === status.progress!.phase);
              const mine = PHASES.findIndex((p) => p.key === key);
              const state = mine < at ? 'done' : mine === at ? 'now' : 'todo';
              return (
                <li key={key} data-state={state}>
                  {label}
                  {state === 'now' && status.progress!.total > 0 && (
                    <span className="count">
                      {' '}
                      {status.progress!.done.toLocaleString()} of{' '}
                      {status.progress!.total.toLocaleString()}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>

          {status.progress.total > 0 && (
            <div
              className="vault-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={status.progress.total}
              aria-valuenow={status.progress.done}
            >
              <span style={{ width: `${(status.progress.done / status.progress.total) * 100}%` }} />
            </div>
          )}

          <p className="muted">
            {timeLeft(status.progress) ?? 'Working out how long this will take…'} — every email and
            every file is read once. You can leave this page.
          </p>
        </div>
      )}

      {error && <p className="muted">{error}</p>}
    </div>
  );
}

/** "Gmail and Drive", not "Gmail, Drive". */
function asList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
