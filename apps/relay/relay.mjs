import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * A residential exit for the hosted API, run on a machine at home.
 *
 * The API lives on a droplet, and a growing list of sites -- YouTube first
 * among them -- serve a bot wall to datacenter IPs and the real page to a
 * home connection. Measured: real Chromium with a warmed cookie session still
 * gets "Sign in to confirm you're not a bot" from the droplet for videos this
 * kind of machine fetches without trouble. The variable is the IP, so the fix
 * has to be an IP.
 *
 * ZERO DEPENDENCIES, ONE FILE, BY DESIGN. Everything that does not need a
 * home IP stays on the droplet. There is no database here, no state, no
 * student data, and nothing to keep in sync -- so there is nothing to break
 * when this machine reboots, and nothing lost if it does.
 *
 *   node relay.mjs        with RELAY_TOKEN set
 *
 * SECURITY. This sits on a home network, beside a router and whatever else is
 * on that LAN. Two rules follow, neither optional:
 *
 *   It binds to LOCALHOST only. The tunnel dials outward from this machine,
 *   so nothing needs to listen on the LAN and nothing does.
 *
 *   It refuses private, loopback and link-local addresses AFTER RESOLVING
 *   them, so a hostname pointing at 192.168.1.1 is refused just as a literal
 *   is. Without that, anyone reaching this relay could read the router's
 *   admin page through it.
 *
 * The address rules are duplicated from packages/agent/src/tools/web/fetch.ts
 * rather than imported, so this file stays runnable with nothing installed.
 * apps/relay/relay.test.mjs pins the behaviour on both sides.
 */

const PORT = Number(process.env.RELAY_PORT ?? 8787);
const TOKEN = process.env.RELAY_TOKEN ?? '';
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const ALLOWED_METHODS = new Set(['GET', 'POST']);

const DROPPED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'authorization',
  'cookie',
  'transfer-encoding',
]);

/** True for anything that must never be reachable through this relay. */
export function isForbiddenAddress(ip) {
  const version = isIP(ip);
  if (version === 0) return true;

  if (version === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  const normalised = ip.toLowerCase().split('%')[0] ?? '';
  if (normalised === '::1' || normalised === '::') return true;
  if (normalised.startsWith('fe80')) return true;
  if (/^f[cd]/.test(normalised)) return true;
  /*
   * IPv4-mapped IPv6 has two spellings, and only the dotted one was checked.
   * The URL parser emits the hex one -- "[::ffff:169.254.169.254]" comes back
   * as "[::ffff:a9fe:a9fe]" -- so cloud metadata read as a public address.
   */
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (dotted?.[1]) return isForbiddenAddress(dotted[1]);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalised);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isForbiddenAddress([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'));
  }
  return false;
}

/** Resolve, and reject unless EVERY answer is public. */
/**
 * @param hostname the host being asked for
 * @param lookup   how to resolve it -- injectable so this can be tested
 *   against a chosen answer rather than against whatever DNS says today. The
 *   attack worth covering is a public-looking name that resolves inward, and
 *   there is no way to write that test with the real resolver.
 */
export async function assertPublicHost(hostname, lookup = dnsLookup) {
  /*
   * An IPv6 literal arrives wrapped in brackets, and isIP() does not know
   * what "[::1]" is -- so the check below was skipped and a loopback address
   * went to the resolver as if it were a hostname.
   */
  const literal =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isIP(literal) !== 0) {
    if (isForbiddenAddress(literal)) throw new Error('address not allowed');
    return;
  }
  let answers;
  try {
    answers = await lookup(hostname, { all: true });
  } catch {
    throw new Error('host not found');
  }
  if (answers.length === 0 || answers.some((a) => isForbiddenAddress(a.address))) {
    throw new Error('address not allowed');
  }
}

function tokenMatches(provided) {
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sanitiseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!DROPPED_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function handle(req, res) {
  if (req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/fetch') return send(res, 404, { error: 'not found' });

  const auth = req.headers.authorization ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!provided || !tokenMatches(provided)) return send(res, 401, { error: 'unauthorized' });

  let request;
  try {
    request = await readJson(req);
  } catch {
    return send(res, 400, { error: 'bad request' });
  }

  let target;
  try {
    target = new URL(request.url);
  } catch {
    return send(res, 400, { error: 'bad url' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return send(res, 400, { error: 'unsupported scheme' });
  }

  const method = (request.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return send(res, 400, { error: 'unsupported method' });

  try {
    await assertPublicHost(target.hostname);
  } catch {
    return send(res, 403, { error: 'address not allowed' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method,
      headers: sanitiseHeaders(request.headers),
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: 'follow',
      signal: controller.signal,
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > MAX_BYTES) return send(res, 413, { error: 'response too large' });

    /*
     * content-encoding and content-length are dropped. fetch has already
     * decompressed the body, so forwarding "gzip" alongside plain bytes tells
     * the caller to gunzip something that is not gzipped, and the length no
     * longer matches either.
     */
    const headers = Object.fromEntries(upstream.headers);
    delete headers['content-encoding'];
    delete headers['content-length'];

    send(res, 200, {
      status: upstream.status,
      finalUrl: upstream.url,
      headers,
      body: buffer.toString('base64'),
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    send(res, aborted ? 504 : 502, { error: aborted ? 'upstream timeout' : 'upstream failed' });
  } finally {
    clearTimeout(timer);
  }
}

// Only start a server when run directly, so the tests can import the parts.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  if (!TOKEN || TOKEN.length < 32) {
    console.error('RELAY_TOKEN must be set and at least 32 characters.');
    console.error('  openssl rand -hex 32');
    process.exit(1);
  }
  createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { error: 'relay error' }));
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`relay listening on 127.0.0.1:${PORT}`);
  });
}
