import { useState } from 'react';
import type { Agent } from '@studentos/shared';
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
        <h1>Student OS</h1>
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
        <h1>Student OS</h1>
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
