import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { MAC_DOWNLOAD } from '../lib/download.js';

interface Site {
  portalId: string;
  origin: string;
  capturedAt: string;
  needsLogin: boolean;
  pages: number;
}

function ago(value: string): string {
  const hours = Math.round((Date.now() - new Date(value).getTime()) / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Sites that need a login.
 *
 * This is the one thing the web app cannot do itself, and the panel says so
 * rather than offering a button that could never work. A page here cannot read
 * another site's session -- that is the same-origin policy, the rule the whole
 * web depends on -- and the server cannot either, because it has no session
 * and cannot pass two-factor. Only software on the student's own machine can.
 */
export function SiteConnections() {
  const [sites, setSites] = useState<Site[] | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.devices.sites.$get();
      if (res.ok) setSites(await res.json());
    })();
  }, []);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Sites that need a login</h2>
      </div>

      <p className="muted">
        Course portals, school systems, anything behind a sign-in. Your agent can read them once a
        computer of yours has signed in.
      </p>

      {sites && sites.length > 0 && (
        <ul className="device-list">
          {sites.map((site) => (
            <li key={site.portalId}>
              <div>
                <strong>{site.origin.replace(/^https?:\/\//, '')}</strong>
                <span className="muted">
                  {' — '}
                  {site.needsLogin
                    ? 'needs signing in again'
                    : site.pages === 0
                      ? 'connected, nothing published yet'
                      : `${site.pages} page${site.pages === 1 ? '' : 's'}`}
                  {' · '}
                  {ago(site.capturedAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="notice">
        Adding a site happens in the desktop app, not here. A web page cannot sign in to another
        site on your behalf — browsers deliberately prevent that, and it is the same rule that stops
        any other site reading your accounts. The app signs in as you, on your machine, and sends
        back only what it finds.
      </div>

      <div className="row" style={{ marginTop: '0.75rem' }}>
        <a className="button primary" href={MAC_DOWNLOAD}>
          Download for Mac
        </a>
        <span className="muted small">Apple Silicon</span>
      </div>
    </div>
  );
}
