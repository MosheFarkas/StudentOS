import { useState } from 'react';
import { api } from '../lib/api.js';

/**
 * The marks beside each connection.
 *
 * Google's own are drawn inline so they are on screen with the row rather
 * than after a request. A custom site has no mark of its own to ship, so its
 * favicon stands in, and its initial when even that cannot be had.
 */

export function ClassroomLogo() {
  return (
    <svg viewBox="0 0 578.9 500" aria-hidden="true" focusable="false">
      <path
        fill="#f4b400"
        d="M539.5 0h-500C17.7 0 0 17.7 0 39.5v421.1C0 482.3 17.7 500 39.5 500h500c21.8 0 39.5-17.7 39.5-39.5V39.5C578.9 17.7 561.3 0 539.5 0z"
      />
      <path fill="#0f9d58" d="M52.6 52.6h473.7v394.7H52.6z" />
      <path
        fill="#57bb8a"
        d="M394.7 263.2c16.4 0 29.6-13.3 29.6-29.6s-13.3-29.6-29.6-29.6-29.6 13.3-29.6 29.6 13.3 29.6 29.6 29.6zm0 19.7c-31.7 0-65.8 16.8-65.8 37.6v21.6h131.6v-21.6c0-20.8-34.1-37.6-65.8-37.6zM184.2 263.2c16.4 0 29.6-13.3 29.6-29.6s-13.3-29.6-29.6-29.6-29.6 13.3-29.6 29.6 13.3 29.6 29.6 29.6zm0 19.7c-31.7 0-65.8 16.8-65.8 37.6v21.6H250v-21.6c0-20.8-34.1-37.6-65.8-37.6z"
      />
      <path
        fill="#f7f7f7"
        d="M289.5 236.8c21.8 0 39.5-17.7 39.4-39.5 0-21.8-17.7-39.5-39.5-39.4-21.8 0-39.4 17.7-39.4 39.5 0 21.8 17.7 39.4 39.5 39.4zm0 26.4c-44.4 0-92.1 23.6-92.1 52.6v26.3h184.2v-26.3c0-29-47.7-52.6-92.1-52.6z"
      />
      <path fill="#f1f1f1" d="M342.1 421.1h118.4v26.3H342.1z" />
    </svg>
  );
}

export function DriveLogo() {
  return (
    <svg viewBox="0 0 87.3 78" aria-hidden="true" focusable="false">
      <path
        d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
        fill="#0066da"
      />
      <path
        d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z"
        fill="#00ac47"
      />
      <path
        d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
        fill="#ea4335"
      />
      <path
        d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
        fill="#00832d"
      />
      <path
        d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
        fill="#2684fc"
      />
      <path
        d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
        fill="#ffba00"
      />
    </svg>
  );
}

export function GmailLogo() {
  return (
    <svg viewBox="52 42 88 66" aria-hidden="true" focusable="false">
      <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
      <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
      <path fill="#fbbc04" d="M120 48v26l20-15v-8.5c0-7.44-8.49-11.68-14.4-7.2" />
      <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
      <path fill="#c5221f" d="M52 50.5V59l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.21-14.4 7.2" />
    </svg>
  );
}

/**
 * A custom site's mark: its own favicon, then a lookup, then its initial.
 *
 * The site itself is asked first, because that involves nobody else and is
 * right whenever it answers -- a real school portal serves its own. Plenty do
 * not: some answer with a login page, some with nothing at all. Then a public
 * lookup is asked, through our own API rather than directly, because from a
 * browser its "unknown site" placeholder is indistinguishable from an icon.
 * When that has nothing either, the letter.
 */
export function SiteLogo({ origin, name }: { origin: string; name: string }) {
  const [attempt, setAttempt] = useState(0);
  const sources = sourcesFor(origin);
  const source = sources[attempt];

  if (!source) {
    return <span className="settings-icon-letter">{name.charAt(0).toUpperCase()}</span>;
  }

  return (
    <img
      src={source}
      alt=""
      width={22}
      height={22}
      onError={() => setAttempt((current) => current + 1)}
    />
  );
}

function sourcesFor(origin: string): string[] {
  try {
    const at = new URL(origin);
    return [
      new URL('/favicon.ico', at).toString(),
      api.devices.sites.icon.$url({ query: { host: at.hostname } }).toString(),
    ];
  } catch {
    return [];
  }
}
