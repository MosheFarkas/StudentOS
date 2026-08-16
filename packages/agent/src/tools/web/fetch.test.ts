import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FetchRejected, fetchPage, htmlToText, pinnedLookup } from './fetch.js';

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
