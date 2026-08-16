import { ProxyAgent } from 'undici';

/**
 * A second way out of the network, for hosts that block datacenters.
 *
 * The problem this solves is not specific to YouTube. Plenty of sites serve a
 * bot wall to any request from a cloud IP range and serve the real page to a
 * home connection. Measured here: YouTube returns 1.1MB of "Sign in to
 * confirm you're not a bot" to this droplet for videos it serves normally to
 * a residential machine -- and no amount of pretending changes it, since real
 * Chromium executing JavaScript with a warmed cookie session fails identically.
 * The variable is the IP, so the fix has to be an IP.
 *
 * Deliberately NOT the default route. Direct requests are free and fast;
 * proxied ones cost per gigabyte and add a hop. Callers try direct first and
 * come here only when they are blocked, which keeps the bill proportional to
 * the blocking rather than to the traffic.
 *
 * Any provider works: this takes a standard proxy URL, so switching is an
 * environment change rather than a code change.
 */
export interface Egress {
  /** Same shape as fetch, routed through a residential IP. */
  fetch: typeof globalThis.fetch;
}

export function createResidentialEgress(proxyUrl: string | undefined): Egress | undefined {
  if (!proxyUrl) return undefined;

  /*
   * One agent, reused. Building a ProxyAgent per request would open a new
   * pool each time, and providers meter connections as well as bytes.
   */
  const agent = new ProxyAgent(proxyUrl);

  const proxiedFetch: typeof globalThis.fetch = (input, init) =>
    globalThis.fetch(input, { ...init, dispatcher: agent } as RequestInit);

  return { fetch: proxiedFetch };
}
