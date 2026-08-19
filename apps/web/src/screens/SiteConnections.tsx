import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { MAC_DOWNLOAD } from '../lib/download.js';
import { Toggle } from './Toggle.js';

interface Site {
  portalId: string;
  origin: string;
  capturedAt: string;
  enabled: boolean;
  needsLogin: boolean;
  pages: number;
}

function describe(site: Site): string {
  if (site.needsLogin) return 'needs signing in again';
  if (site.pages === 0) return 'nothing published yet';
  return `${site.pages} page${site.pages === 1 ? '' : 's'}`;
}

/**
 * Sites behind a login, as a part of Connections rather than a rival to it.
 *
 * Off and Remove are deliberately different actions: off keeps the pages and
 * the sign-in, so it costs nothing to undo, while remove deletes what the
 * server holds. Offering only one would make the cheap choice look expensive.
 */
export function SiteConnections() {
  const [sites, setSites] = useState<Site[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const res = await api.devices.sites.$get();
    if (res.ok) setSites(await res.json());
  }

  useEffect(() => {
    void load();
  }, []);

  async function setEnabled(site: Site, enabled: boolean) {
    setBusy(site.portalId);
    await api.devices.sites[':portalId'].enabled.$post({
      param: { portalId: site.portalId },
      json: { enabled },
    });
    await load();
    setBusy(null);
  }

  async function remove(site: Site) {
    const name = site.origin.replace(/^https?:\/\//, '');
    if (!confirm(`Remove ${name}? What it has read will be deleted.`)) return;
    setBusy(site.portalId);
    await api.devices.sites[':portalId'].$delete({ param: { portalId: site.portalId } });
    await load();
    setBusy(null);
  }

  return (
    <div className="subsection">
      <h3>Sites that need a login</h3>
      <p className="muted">
        Course portals and anything else behind a sign-in. Added in the desktop app.
      </p>

      {sites.length > 0 && (
        <ul className="device-list">
          {sites.map((site) => (
            <li key={site.portalId}>
              <div>
                <strong>{site.origin.replace(/^https?:\/\//, '')}</strong>
                <span className="muted"> — {describe(site)}</span>
              </div>
              <div className="row">
                <Toggle
                  checked={site.enabled}
                  disabled={busy === site.portalId}
                  label={`Let your agent read ${site.origin}`}
                  onChange={(next) => void setEnabled(site, next)}
                />
                <button disabled={busy === site.portalId} onClick={() => void remove(site)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="muted download-label">Download ContextoAgent desktop app</p>
      <a className="button blue" href={MAC_DOWNLOAD}>
        Download for macOS
      </a>
    </div>
  );
}
