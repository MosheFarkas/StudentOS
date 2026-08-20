import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';

type State =
  | { status: 'loading' }
  | { status: 'ready'; deviceName: string }
  | { status: 'approved'; deviceName: string }
  | { status: 'expired' };

/**
 * Approving a desktop companion.
 *
 * The student reaches this because the app opened their browser here. What
 * they are agreeing to is worth stating plainly on the page rather than in a
 * help article: that computer will be able to read the sites they sign into on
 * it, and send what it finds back to their account.
 *
 * Nothing here is one-click-from-an-email safe by accident -- approval is a
 * POST from an authenticated session, and the request expires in ten minutes.
 */
export function LinkDevice({ requestId }: { requestId: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await api.devices.link[':id'].$get({ param: { id: requestId } });
      if (cancelled) return;
      if (!res.ok) return setState({ status: 'expired' });
      const request = await res.json();
      setState({ status: 'ready', deviceName: request.deviceName });
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  async function approve(deviceName: string) {
    setBusy(true);
    const res = await api.devices.link[':id'].approve.$post({ param: { id: requestId } });
    setBusy(false);
    setState(res.ok ? { status: 'approved', deviceName } : { status: 'expired' });
  }

  if (state.status === 'loading') {
    return (
      <div className="panel">
        <p className="muted">Checking…</p>
      </div>
    );
  }

  if (state.status === 'expired') {
    return (
      <div className="panel">
        <h2>This link request has expired</h2>
        <p className="muted">
          Requests last ten minutes. Run <code>link</code> in the desktop app again to get a new
          one.
        </p>
        <button onClick={() => navigate({ name: 'agents' })}>Back to agents</button>
      </div>
    );
  }

  if (state.status === 'approved') {
    return (
      <div className="panel">
        <h2>{state.deviceName} is linked</h2>
        <p className="muted">You can close this tab and go back to the app.</p>
        <button className="primary" onClick={() => navigate({ name: 'settings' })}>
          Manage devices
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Link this computer?</h2>
      <p>
        <strong>{state.deviceName}</strong> is asking to connect to your account.
      </p>
      <div className="notice">
        Once linked, this computer can read the sites you sign into on it and send what it finds to
        your account. Only approve it if you started this yourself.
      </div>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => void approve(state.deviceName)}>
          {busy ? 'Linking…' : 'Approve'}
        </button>
        <button disabled={busy} onClick={() => navigate({ name: 'agents' })}>
          Cancel
        </button>
      </div>
    </div>
  );
}
