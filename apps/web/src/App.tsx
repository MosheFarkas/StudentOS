import { useEffect } from 'react';
import { api } from './lib/api.js';
import { MAC_DOWNLOAD } from './lib/download.js';
import { navigate, useRoute } from './lib/router.js';
import { signInWithGoogle, signOut, useSession } from './lib/auth.js';
import { Agents } from './screens/Agents.js';
import { Chat } from './screens/Chat.js';
import { LinkDevice } from './screens/LinkDevice.js';
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
        <div className="signin">
          <img src="/logo.png" alt="ContextoAgent" />
          <p className="muted">An AI agent that knows your coursework.</p>
          <div className="panel">
            <p>Sign in with your educational Google account to get started.</p>
            <button className="primary" onClick={() => void signInWithGoogle()}>
              Continue with Google
            </button>
          </div>

          {/*
            Outside the panel and below it, deliberately. Signing in is what a
            new visitor needs first; the app is useless until there is an
            account to link it to.
          */}
          <p className="muted download-label">Download ContextoAgent desktop app</p>
          <a className="button" href={MAC_DOWNLOAD}>
            Download for macOS
          </a>
        </div>
      </main>
    );
  }

  return (
    <main>
      <header className="app-header">
        <button
          className="brand"
          aria-label="Your agents"
          onClick={() => navigate({ name: 'agents' })}
        >
          <img src="/logo.png" alt="ContextoAgent" />
        </button>
        <nav>
          {route.name !== 'settings' && (
            <button className="quiet" onClick={() => navigate({ name: 'settings' })}>
              Settings
            </button>
          )}
          <button className="quiet" onClick={() => void signOut()}>
            Sign out
          </button>
        </nav>
      </header>

      {route.name === 'agents' && (
        <Agents onOpen={(agent) => navigate({ name: 'chat', agentId: agent.id })} />
      )}

      {route.name === 'chat' && (
        <Chat agentId={route.agentId} onBack={() => navigate({ name: 'agents' })} />
      )}

      {route.name === 'settings' && <Settings onBack={() => navigate({ name: 'agents' })} />}

      {route.name === 'link' && <LinkDevice requestId={route.requestId} />}

      {route.name === 'notFound' && (
        <div className="panel">
          <p>There&apos;s nothing at this address.</p>
          <button onClick={() => navigate({ name: 'agents' })}>Go to your agents</button>
        </div>
      )}
    </main>
  );
}
