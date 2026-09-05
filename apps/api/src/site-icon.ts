/**
 * A custom site's mark, looked up by hostname.
 *
 * The settings page tries the site's own /favicon.ico first, in the browser.
 * This is the second try, through a public lookup, and it lives on the server
 * because the browser cannot read the answer: the lookup replies to a site it
 * does not know with a placeholder picture and a 404, and an <img> shows the
 * picture regardless. Here the status is read, and an unknown site is nothing
 * -- so the page can fall through to the site's initial.
 */

export interface SiteIcon {
  type: string;
  bytes: ArrayBuffer;
}

/** A hostname and nothing else: no path, no port, no scheme, no spaces. */
export const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export async function lookupSiteIcon(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SiteIcon | null> {
  if (!HOSTNAME.test(host)) return null;

  try {
    const res = await fetchImpl(`https://icons.duckduckgo.com/ip3/${host}.ico`, {
      signal: AbortSignal.timeout(5000),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return null;
    return { type, bytes: await res.arrayBuffer() };
  } catch {
    // Down, slow, or refusing: a missing mark, not a failed page.
    return null;
  }
}
