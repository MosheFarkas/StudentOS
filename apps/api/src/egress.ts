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

/**
 * Egress through a relay running on a machine at home.
 *
 * Preferred over a rented proxy when one is available: the residential IP is
 * one you already own, so there is no per-gigabyte bill and no third party in
 * the path of your students' requests.
 *
 * Shaped as a plain fetch so callers cannot tell the difference. The relay
 * returns the response base64-encoded inside JSON, which is what lets a
 * single endpoint carry HTML, JSON and binary alike.
 */
export function createRelayEgress(relayUrl: string, token: string): Egress {
  const relayFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    const body =
      init?.body === undefined || init.body === null
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : Buffer.from(init.body as ArrayBuffer).toString('utf8');

    const response = await globalThis.fetch(new URL('/fetch', relayUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        method: init?.method ?? 'GET',
        headers: headersToObject(init?.headers),
        ...(body !== undefined ? { body } : {}),
      }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });

    if (!response.ok) {
      // The relay being down or refusing must look like a failed request,
      // not throw something the tool layer has never seen.
      throw new Error(`relay returned ${response.status}`);
    }

    const payload = (await response.json()) as {
      status: number;
      finalUrl?: string;
      headers?: Record<string, string>;
      body: string;
    };

    return new Response(Buffer.from(payload.body, 'base64'), {
      status: payload.status,
      headers: payload.headers ?? {},
    });
  };

  return { fetch: relayFetch };
}

function headersToObject(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers);
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
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
