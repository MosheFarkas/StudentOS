import { useState } from 'react';

/**
 * The marks beside each connection.
 *
 * Google's own are drawn inline so they are on screen with the row rather
 * than after a request. A custom site has no mark of its own to ship, so its
 * favicon stands in, and its initial when even that cannot be had.
 */

export function ClassroomLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="20" height="20" rx="3" fill="#0f9d58" />
      <rect x="4" y="4" width="16" height="16" fill="#57bb8a" />
      <circle cx="12" cy="9.6" r="2.1" fill="#f7cb4d" />
      <path d="M8.2 16.2c0-2 1.7-3.3 3.8-3.3s3.8 1.3 3.8 3.3z" fill="#f7cb4d" />
      <circle cx="7.4" cy="10.8" r="1.5" fill="#fff" />
      <path d="M4.6 16.2c0-1.5 1.2-2.5 2.8-2.5s2.8 1 2.8 2.5z" fill="#fff" />
      <circle cx="16.6" cy="10.8" r="1.5" fill="#fff" />
      <path d="M13.8 16.2c0-1.5 1.2-2.5 2.8-2.5s2.8 1 2.8 2.5z" fill="#fff" />
      <rect x="14" y="18.6" width="5" height="1.4" fill="#fff" />
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
 * A custom site's own favicon, or its initial when there is none to be had.
 *
 * Asked of the site itself rather than a lookup service: the one tried
 * answered a real school portal with its generic globe, where the portal's
 * own /favicon.ico is the actual mark. A site that answers with a login page
 * instead fails to decode, and the letter takes over.
 */
export function SiteLogo({ origin, name }: { origin: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const source = faviconOf(origin);

  if (!source || failed) {
    return <span className="settings-icon-letter">{name.charAt(0).toUpperCase()}</span>;
  }

  return <img src={source} alt="" width={22} height={22} onError={() => setFailed(true)} />;
}

function faviconOf(origin: string): string | null {
  try {
    return new URL('/favicon.ico', origin).toString();
  } catch {
    return null;
  }
}
