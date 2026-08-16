import { useEffect } from 'react';
import { api } from './lib/api.js';
import { navigate, useRoute } from './lib/router.js';
import { signInWithGoogle, signOut, useSession } from './lib/auth.js';
import { Agents } from './screens/Agents.js';
import { Chat } from './screens/Chat.js';
import { Settings } from './screens/Settings.js';

export function App() {
  const { data: session, isPending } = useSession();
  // View state lives in the URL now, so refresh and Back both behave.
  const route = useRoute();

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
          {route.name !== 'settings' && (
            <button onClick={() => navigate({ name: 'settings' })}>Settings</button>
          )}
          <button onClick={() => void signOut()}>Sign out</button>
        </nav>
      </header>

      {route.name === 'agents' && (
        <Agents onOpen={(agent) => navigate({ name: 'chat', agentId: agent.id })} />
      )}

      {route.name === 'chat' && (
        <Chat agentId={route.agentId} onBack={() => navigate({ name: 'agents' })} />
      )}

      {route.name === 'settings' && <Settings onBack={() => navigate({ name: 'agents' })} />}

      {route.name === 'notFound' && (
        <div className="panel">
          <p>There&apos;s nothing at this address.</p>
          <button onClick={() => navigate({ name: 'agents' })}>Go to your agents</button>
        </div>
      )}
    </main>
  );
}
