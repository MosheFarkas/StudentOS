import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { desktop } from './lib/desktop.js';
import { MAC_DOWNLOAD } from './lib/download.js';
import { navigate, useRoute } from './lib/router.js';
import { signInWithGoogle, signOut, useSession } from './lib/auth.js';
import { WorkingProvider } from './lib/working.js';
import { LogoMark } from './screens/LogoMark.js';
import { Agents } from './screens/Agents.js';
import { Chat } from './screens/Chat.js';
import { LinkDevice } from './screens/LinkDevice.js';
import { Settings } from './screens/Settings.js';

export function App() {
  const { data: session, isPending } = useSession();
  /*
   * Set by whichever screen is open. Only the header reads it, and only to
   * decide whether its mark is folding.
   */
  const [working, setWorking] = useState(false);
  const report = useCallback((next: boolean) => setWorking(next), []);
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
            {/*
              Inside the desktop app, signing in does not go through Google
              here. A linked computer can exchange its link for a session --
              the same question already answered when it was linked -- and if
              that fails the app opens the student's own browser, where they
              are already signed in and can see the address bar.
            */}
            {desktop()?.signIn ? (
              <button
                className="primary"
                onClick={async () => {
                  const result = await desktop()?.signIn?.();
                  if (result && !result.ok) alert(result.error ?? 'Could not sign in.');
                }}
              >
                Continue with Google
              </button>
            ) : (
              <button className="primary" onClick={() => void signInWithGoogle()}>
                Continue with Google
              </button>
            )}
          </div>

          {/*
            Outside the panel and below it, deliberately. Signing in is what a
            new visitor needs first; the app is useless until there is an
            account to link it to. Hidden inside the desktop app, where
            offering the download would be offering them what they are using.
          */}
          {!desktop() && (
            <>
              <p className="muted download-label">Download ContextoAgent desktop app</p>
              <a className="button blue" href={MAC_DOWNLOAD}>
                Download for macOS
              </a>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <WorkingProvider value={report}>
      <main>
        <header className="app-header">
          <button
            className="brand"
            aria-label="Your agents"
            onClick={() => navigate({ name: 'agents' })}
          >
            {/*
              The lockup, split in two so only the mark moves. The sizes are
              the proportions it had as a single image, so the header looks
              exactly as it did until the agent starts working.
            */}
            <LogoMark size={25.6} working={working} />
            <img className="brand-wordmark" src="/wordmark.png" alt="ContextoAgent" />
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
          /*
           * Keyed, so moving between conversations builds a new one rather than
           * repainting the old.
           *
           * Without it React kept a single Chat and only swapped the prop, so
           * everything it was holding came along: a reply still in flight landed
           * in whichever conversation was open by the time it arrived, the
           * composer stayed disabled because some other chat was mid-turn, and a
           * half-typed message followed you into a different agent. A
           * conversation is not a repaint of another one.
           */
          <Chat
            key={route.agentId}
            agentId={route.agentId}
            onBack={() => navigate({ name: 'agents' })}
          />
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
    </WorkingProvider>
  );
}
