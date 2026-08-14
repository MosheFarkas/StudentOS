import { useEffect, useState } from 'react';
import type { Agent } from '@contexto/shared';
import { api } from './lib/api.js';
import { signInWithGoogle, signOut, useSession } from './lib/auth.js';
import { Agents } from './screens/Agents.js';
import { Chat } from './screens/Chat.js';
import { Settings } from './screens/Settings.js';

/**
 * View state is held in React rather than the URL.
 *
 * TODO(routing): this means refresh drops you back to the agent list and there
 * are no shareable links. Fine while the app is three screens; add a router
 * before it is more.
 */
type View = { name: 'agents' } | { name: 'chat'; agent: Agent } | { name: 'settings' };

export function App() {
  const { data: session, isPending } = useSession();
  const [view, setView] = useState<View>({ name: 'agents' });

  /*
   * Report the browser's timezone once signed in.
   *
   * The server cannot infer this reliably, and without it the agent asks what
   * timezone you are in every time you mention "tomorrow". Fire-and-forget:
   * a failure here should never block the app.
   */
  useEffect(() => {
    if (!session?.user) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return;
    void api.me.timezone.$put({ json: { timezone } }).catch(() => {});
  }, [session?.user]);

  if (isPending) {
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main>
        <h1>Contexto</h1>
        <p className="muted">Build your own AI agent.</p>
        <div className="panel">
          <p>Sign in with your school or personal Google account to get started.</p>
          <button onClick={() => void signInWithGoogle()}>Continue with Google</button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <header className="app-header">
        <h1>Contexto</h1>
        <nav>
          {view.name !== 'settings' && (
            <button onClick={() => setView({ name: 'settings' })}>Settings</button>
          )}
          <button onClick={() => void signOut()}>Sign out</button>
        </nav>
      </header>

      {view.name === 'agents' && <Agents onOpen={(agent) => setView({ name: 'chat', agent })} />}

      {view.name === 'chat' && (
        <Chat agent={view.agent} onBack={() => setView({ name: 'agents' })} />
      )}

      {view.name === 'settings' && <Settings onBack={() => setView({ name: 'agents' })} />}
    </main>
  );
}
