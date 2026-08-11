import { useEffect, useState } from 'react';
import type { UsageStatus } from '@studentos/shared';
import { api } from './lib/api.js';
import { signInWithGoogle, signOut, useSession } from './lib/auth.js';

/**
 * Scaffold UI.
 *
 * Deliberately minimal: it signs in and reads one endpoint, which is enough to
 * prove auth, CORS, the typed client, and the provider resolver are wired
 * together. The actual agent-building interface is the next piece of work and
 * needs its own design pass -- the whole product thesis is that a
 * non-technical student can build an agent here, and that lives or dies on
 * this screen, not on the plumbing behind it.
 */
export function App() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Student OS</h1>
      <p className="muted">Build your own AI agent.</p>

      {session?.user ? (
        <>
          <div className="panel">
            <p>
              Signed in as <strong>{session.user.email}</strong>
            </p>
            <button onClick={() => void signOut()}>Sign out</button>
          </div>
          <UsagePanel />
        </>
      ) : (
        <div className="panel">
          <p>Sign in with your school or personal Google account to get started.</p>
          <button onClick={() => void signInWithGoogle()}>Continue with Google</button>
        </div>
      )}
    </main>
  );
}

function UsagePanel() {
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await api.usage.$get();
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        const data = (await response.json()) as UsageStatus;
        if (!cancelled) setUsage(data);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unknown error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="panel">
        <p className="muted">Could not load usage: {error}</p>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="panel">
        <p className="muted">Loading usage…</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <dl>
        <dt>Model</dt>
        <dd>{usage.activeProvider === 'platform' ? 'Included (free tier)' : 'Your own API key'}</dd>

        {usage.quota && (
          <>
            <dt>Used</dt>
            <dd>
              {usage.quota.tokensUsed.toLocaleString()} / {usage.quota.tokenLimit.toLocaleString()}{' '}
              tokens
            </dd>
          </>
        )}
      </dl>
      {usage.quota && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Add your own API key for unlimited use.
        </p>
      )}
    </div>
  );
}
