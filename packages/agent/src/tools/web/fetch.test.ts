import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FetchRejected,
  fetchPage,
  htmlToText,
  isForbiddenAddress,
  pinnedLookup,
  resolvePublicAddress,
} from './fetch.js';

/**
 * SSRF is the reason this module exists, so it is the bulk of what is tested.
 *
 * These are not hypothetical targets. From the production droplet,
 * http://169.254.169.254/metadata/v1.json returns droplet metadata including
 * vendor_data, and the API itself answers on 127.0.0.1:3210 -- both verified
 * reachable before this code was written. A link attachment in Classroom is
 * attacker-controlled input that reaches this function.
 */
describe('blocked destinations', () => {
  const cases: [string, string][] = [
    ['cloud metadata', 'http://169.254.169.254/metadata/v1.json'],
    ['loopback by ip', 'http://127.0.0.1:3210/api/health'],
    ['loopback by name', 'http://localhost:3210/api/health'],
    ['private 10/8', 'http://10.0.0.1/'],
    ['private 172.16/12', 'http://172.16.5.4/'],
    ['private 192.168/16', 'http://192.168.1.1/'],
    ['carrier NAT', 'http://100.64.0.1/'],
    ['all-zeros', 'http://0.0.0.0/'],
    ['ipv6 loopback', 'http://[::1]/'],
    ['ipv6 link-local', 'http://[fe80::1]/'],
    ['ipv6 unique-local', 'http://[fd00::1]/'],
    // The v4 range smuggled through a v6 literal.
    ['ipv4-mapped metadata', 'http://[::ffff:169.254.169.254]/'],
  ];

  for (const [name, url] of cases) {
    it(`rejects ${name}`, async () => {
      await expect(fetchPage(url)).rejects.toBeInstanceOf(FetchRejected);
    });
  }

  it('rejects non-http schemes', async () => {
    await expect(fetchPage('file:///etc/passwd')).rejects.toBeInstanceOf(FetchRejected);
    await expect(fetchPage('gopher://example.com/')).rejects.toBeInstanceOf(FetchRejected);
  });

  it('rejects a malformed url', async () => {
    await expect(fetchPage('not a url')).rejects.toBeInstanceOf(FetchRejected);
  });
});

describe('redirects', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/to-metadata') {
        // The classic bypass: a public URL that redirects inward. Checking
        // only the URL the student supplied would sail straight through this.
        res.writeHead(302, { location: 'http://169.254.169.254/metadata/v1.json' });
        res.end();
        return;
      }
      if (req.url === '/to-loopback') {
        res.writeHead(302, { location: 'http://127.0.0.1:9/' });
        res.end();
        return;
      }
      if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      }
      if (req.url === '/binary') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end('PK');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>Syllabus</title></head><body><p>Read chapter 4.</p></body></html>',
      );
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /*
   * The local server is itself on loopback, so fetchPage refuses to reach it
   * at all -- which is the correct behaviour and also means the redirect
   * targets below are unreachable for the right reason. Asserting the
   * rejection keeps the guarantee explicit rather than incidental.
   */
  it('will not fetch a loopback origin even to follow it', async () => {
    await expect(fetchPage(`${base}/to-metadata`)).rejects.toBeInstanceOf(FetchRejected);
    await expect(fetchPage(`${base}/to-loopback`)).rejects.toBeInstanceOf(FetchRejected);
    await expect(fetchPage(`${base}/loop`)).rejects.toBeInstanceOf(FetchRejected);
    await expect(fetchPage(`${base}/binary`)).rejects.toBeInstanceOf(FetchRejected);
  });
});

describe('htmlToText', () => {
  it('drops scripts and styles entirely', () => {
    const text = htmlToText(
      '<html><style>.a{color:red}</style><script>alert("x")</script><p>Chapter 4</p></html>',
    );
    expect(text).toBe('Chapter 4');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color');
  });

  it('keeps block boundaries so sentences do not merge', () => {
    expect(htmlToText('<p>First.</p><p>Second.</p>')).toBe('First.\n\nSecond.');
    expect(htmlToText('<li>One</li><li>Two</li>')).toContain('One');
  });

  it('decodes entities, including numeric ones', () => {
    expect(htmlToText('<p>Caf&eacute; &amp; bar</p>')).toContain('&');
    expect(htmlToText('<p>&#65;&#66;</p>')).toBe('AB');
    expect(htmlToText('<p>&#x41;</p>')).toBe('A');
    expect(htmlToText('<p>a&nbsp;b</p>')).toContain('a b');
  });

  it('survives malformed markup rather than throwing', () => {
    // Real pages are broken in exactly these ways.
    expect(() => htmlToText('<p>unclosed <b>bold')).not.toThrow();
    expect(() => htmlToText('<<<>>>')).not.toThrow();
    expect(() => htmlToText('&#999999999;')).not.toThrow();
    expect(() => htmlToText('<!-- unterminated comment')).not.toThrow();
  });

  it('leaves an unknown entity alone instead of mangling it', () => {
    expect(htmlToText('<p>&madeup;</p>')).toBe('&madeup;');
  });
});

describe('pinnedLookup', () => {
  const pinned = { address: '208.80.154.224', family: 4 };

  /**
   * The regression that shipped a total outage.
   *
   * Node's socket layer calls the lookup hook with {hints, all: true} and
   * then expects an array. Answering with the bare (address, family) form
   * throws ERR_INVALID_IP_ADDRESS, so EVERY fetch failed while every existing
   * test still passed -- because they only used addresses rejected before
   * this code ran. Verified against Node 22 in production.
   */
  it('answers with an array when Node asks for all', () => {
    let received: unknown;
    pinnedLookup(pinned)('example.com', { hints: 32, all: true }, ((_e: null, value: unknown) => {
      received = value;
    }) as never);

    expect(received).toEqual([{ address: '208.80.154.224', family: 4 }]);
  });

  it('answers with address and family when Node does not', () => {
    const args: unknown[] = [];
    pinnedLookup(pinned)('example.com', { hints: 32 }, ((...received: unknown[]) => {
      args.push(...received);
    }) as never);

    expect(args).toEqual([null, '208.80.154.224', 4]);
  });

  it('treats a missing options object as the non-array form', () => {
    const args: unknown[] = [];
    pinnedLookup(pinned)('example.com', undefined, ((...received: unknown[]) => {
      args.push(...received);
    }) as never);

    expect(args[1]).toBe('208.80.154.224');
  });
});

describe('residential retry', () => {
  /**
   * A 403 from a datacenter is very often "you are a bot" rather than "you
   * may not have this" -- measured on YouTube, which serves a wall to this
   * host and the real page to a home connection. Only 403 and 429 retry, so
   * a genuine 404 or a paywall never spends proxy bandwidth.
   */
  it('does not retry statuses that are not blocking', async () => {
    const transport = vi.fn();
    // Loopback is refused before any request, so the proxy must stay unused.
    await expect(fetchPage('http://127.0.0.1:9/', transport as never)).rejects.toBeInstanceOf(
      FetchRejected,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * The SSRF checks are NOT skipped on the proxied path. Our own network is
   * out of reach once the proxy makes the connection, but pointing someone
   * else's proxy at internal addresses is rude and gets accounts suspended.
   */
  it('still refuses internal addresses even with an egress available', async () => {
    const transport = vi.fn();
    for (const url of ['http://169.254.169.254/', 'http://10.0.0.1/', 'http://[::1]/']) {
      await expect(fetchPage(url, transport as never)).rejects.toBeInstanceOf(FetchRejected);
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

/**
 * What a name resolves to, rather than what it looks like.
 *
 * The guard checks every DNS answer, and until the resolver could be chosen
 * there was no way to test that: the real one will not return 127.0.0.1 for a
 * public name on request. So the case the check exists for -- DNS rebinding,
 * where an innocuous hostname answers with an internal address -- was the one
 * case going unverified.
 */
describe('what a hostname resolves to', () => {
  const resolvesTo =
    (...addresses: string[]) =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('allows a name that resolves to a public address', async () => {
    await expect(resolvePublicAddress('example.com', resolvesTo('93.184.216.34'))).resolves.toEqual(
      { address: '93.184.216.34', family: 4 },
    );
  });

  it('refuses a public-looking name that resolves to loopback', async () => {
    await expect(
      resolvePublicAddress('totally-fine.example', resolvesTo('127.0.0.1')),
    ).rejects.toBeInstanceOf(FetchRejected);
  });

  it('refuses one that resolves to cloud metadata', async () => {
    // The address that returns droplet metadata in production.
    await expect(
      resolvePublicAddress('totally-fine.example', resolvesTo('169.254.169.254')),
    ).rejects.toBeInstanceOf(FetchRejected);
  });

  it('refuses when any answer is internal, not merely the first', async () => {
    await expect(
      resolvePublicAddress('mixed.example', resolvesTo('93.184.216.34', '10.0.0.5')),
    ).rejects.toBeInstanceOf(FetchRejected);
  });

  it('refuses an ipv6 answer that points inward', async () => {
    await expect(resolvePublicAddress('v6.example', resolvesTo('::1'))).rejects.toBeInstanceOf(
      FetchRejected,
    );
  });

  it('refuses a name that resolves to nothing at all', async () => {
    await expect(resolvePublicAddress('empty.example', resolvesTo())).rejects.toBeInstanceOf(
      FetchRejected,
    );
  });
});

/**
 * IPv6 literals arrive wrapped in brackets.
 *
 * `new URL('http://[::1]/').hostname` is "[::1]", and isIP() does not know
 * what that is -- so the literal-address check was skipped and a loopback
 * address went to the resolver as if it were a name. It failed closed only
 * because the lookup happened to fail, which is luck rather than a guard, and
 * slow luck at that: the test for it timed out at five seconds.
 */
describe('bracketed ipv6 literals', () => {
  /*
   * A resolver that would happily allow anything.
   *
   * Rejection therefore proves the literal-address check ran; a test using a
   * failing resolver would pass either way and prove nothing, which is how
   * this went unnoticed.
   */
  let asked: string[] = [];
  const wouldAllow = async (host: string) => {
    asked.push(host);
    return [{ address: '93.184.216.34', family: 4 }];
  };

  beforeEach(() => {
    asked = [];
  });

  it('rejects bracketed loopback even when the resolver would allow it', async () => {
    await expect(resolvePublicAddress('[::1]', wouldAllow)).rejects.toBeInstanceOf(FetchRejected);
    expect(asked).toEqual([]);
  });

  it('rejects bracketed link-local even when the resolver would allow it', async () => {
    await expect(resolvePublicAddress('[fe80::1]', wouldAllow)).rejects.toBeInstanceOf(
      FetchRejected,
    );
    expect(asked).toEqual([]);
  });

  it('rejects a bracketed ipv4-mapped loopback', async () => {
    await expect(resolvePublicAddress('[::ffff:127.0.0.1]', wouldAllow)).rejects.toBeInstanceOf(
      FetchRejected,
    );
    expect(asked).toEqual([]);
  });

  it('still allows a bracketed public address, without a lookup', async () => {
    await expect(resolvePublicAddress('[2606:4700:4700::1111]', wouldAllow)).resolves.toMatchObject(
      { family: 6 },
    );
    expect(asked).toEqual([]);
  });
});

/**
 * IPv4-mapped IPv6, in the form the URL parser actually produces.
 *
 * `new URL('http://[::ffff:169.254.169.254]/').hostname` is
 * "[::ffff:a9fe:a9fe]" -- the parser rewrites the dotted tail as hex. The
 * mapped-address check only understood the dotted spelling, so the hex one
 * was not recognised as IPv4 at all and cloud metadata read as a public
 * address. It was reachable only because a bracketed literal used to fall
 * through to DNS and fail there; the moment that was fixed, this became a
 * live route to 169.254.169.254.
 */
describe('ipv4-mapped addresses in hex form', () => {
  it('recognises hex-form metadata as forbidden', () => {
    expect(isForbiddenAddress('::ffff:a9fe:a9fe')).toBe(true);
  });

  it('recognises hex-form loopback as forbidden', () => {
    expect(isForbiddenAddress('::ffff:7f00:1')).toBe(true);
  });

  it('recognises hex-form private ranges as forbidden', () => {
    expect(isForbiddenAddress('::ffff:a00:1')).toBe(true); // 10.0.0.1
    expect(isForbiddenAddress('::ffff:c0a8:1')).toBe(true); // 192.168.0.1
  });

  it('still allows a genuinely public mapped address', () => {
    expect(isForbiddenAddress('::ffff:5db8:d822')).toBe(false); // 93.184.216.34
  });

  it('agrees with the dotted spelling of the same address', () => {
    expect(isForbiddenAddress('::ffff:169.254.169.254')).toBe(
      isForbiddenAddress('::ffff:a9fe:a9fe'),
    );
  });
});
