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

interface Status {
  ready: boolean;
  missing: string[];
  entities: number;
  episodes: number;
  building: boolean;
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
            ? `Building… ${total.toLocaleString()} notes so far`
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

      {status.building && (
        <p className="muted">
          This takes a while: every email and every file is read once. You can leave this page.
        </p>
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
