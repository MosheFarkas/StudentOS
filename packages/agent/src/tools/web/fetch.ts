import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { extractPdfText } from '../pdf.js';

/**
 * Fetching a web page on the student's behalf.
 *
 * This is the one place in the product where a URL chosen by someone else --
 * a teacher's Classroom link, or anything the model decides to follow --
 * causes our SERVER to make a request. That makes it the SSRF surface, and it
 * is not theoretical: from this droplet, http://169.254.169.254/metadata/v1.json
 * returns droplet metadata including vendor_data, and http://127.0.0.1:3210
 * is the API itself. A naive fetch here would hand both to anyone who can get
 * a link in front of the agent.
 *
 * The defence is resolve-then-pin:
 *
 *   1. Resolve the hostname ourselves and reject any private, loopback,
 *      link-local, reserved, or multicast address.
 *   2. Connect to THAT EXACT IP, by pinning the socket's DNS lookup. Without
 *      this there is a window between our check and the connection in which a
 *      hostile nameserver can answer differently -- DNS rebinding, and the
 *      reason checking the hostname string alone is worthless.
 *   3. Re-run both steps on every redirect hop. A public URL redirecting to
 *      169.254.169.254 is the standard bypass.
 */

/** Bounded so a hostile or broken site cannot hold a turn open. */
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 3 * 1024 * 1024;
/** Matches the Drive reader: enough to answer from, not enough to flood context. */
const MAX_CHARS = 40_000;

export interface FetchedPage {
  url: string;
  title: string | null;
  text: string;
  truncated: boolean;
  /**
   * How the text was obtained.
   *
   * Callers need this because "hardly any text" means different things per
   * kind: an almost-empty HTML page is usually one that builds itself with
   * JavaScript, while an almost-empty PDF has already been checked for a text
   * layer by the extractor. Treating them the same rejected a valid
   * fourteen-character PDF as a broken page.
   */
  kind: 'html' | 'text' | 'pdf';
}

export class FetchRejected extends Error {}

/** True for anything that must never be reachable from our server. */
export function isForbiddenAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return true;

  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  const normalised = ip.toLowerCase().split('%')[0] ?? '';
  if (normalised === '::1' || normalised === '::') return true;
  if (normalised.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(normalised)) return true; // unique local
  /*
   * IPv4-mapped IPv6 smuggles the whole v4 problem back in, and it has two
   * spellings. The dotted one is what a person writes; the hex one is what
   * comes back out of the URL parser, which rewrites
   * "[::ffff:169.254.169.254]" as "[::ffff:a9fe:a9fe]". Only the first was
   * recognised, so the address the parser actually produces for cloud
   * metadata read as an ordinary public address.
   */
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (dotted?.[1]) return isForbiddenAddress(dotted[1]);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalised);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const quad = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    return isForbiddenAddress(quad);
  }
  return false;
}

/**
 * Resolve, and reject unless EVERY answer is a public address.
 *
 * The resolver is injectable so the guard can be tested against a chosen
 * answer. The attack worth covering is a public-looking hostname that
 * resolves inward -- DNS rebinding -- and there is no way to write that test
 * against the real resolver, which is why it went uncovered.
 */
export async function resolvePublicAddress(
  hostname: string,
  lookup: (
    host: string,
    options: { all: true },
  ) => Promise<{ address: string; family: number }[]> = dnsLookup,
): Promise<{ address: string; family: number }> {
  /*
   * An IPv6 literal arrives wrapped in brackets.
   *
   * `new URL('http://[::1]/').hostname` is "[::1]", and isIP() does not
   * recognise that, so the literal-address check below was skipped entirely
   * and a loopback address was handed to the resolver as though it were a
   * name. It failed closed only because that lookup failed -- luck, not a
   * guard. A resolver that answered would have let it straight through.
   */
  const literal =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isIP(literal) !== 0) {
    if (isForbiddenAddress(literal)) {
      throw new FetchRejected('That address is not allowed.');
    }
    return { address: literal, family: isIP(literal) };
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(hostname, { all: true });
  } catch {
    throw new FetchRejected(`Could not find ${hostname}.`);
  }

  // Every answer, not just the one we use: a host answering with one public
  // and one internal address must not be reachable at all.
  if (answers.length === 0 || answers.some((a) => isForbiddenAddress(a.address))) {
    throw new FetchRejected('That address is not allowed.');
  }
  return answers[0] as { address: string; family: number };
}

/**
 * A DNS lookup that always answers with one pre-validated address.
 *
 * This is what makes the check meaningful: Node connects to the address we
 * already inspected rather than resolving the hostname a second time, closing
 * the window a hostile nameserver would use to answer differently.
 *
 * BOTH callback shapes are required. Node's socket layer calls this with
 * `{all: true}` and then expects an ARRAY; answering with the bare
 * (address, family) form throws ERR_INVALID_IP_ADDRESS and every single fetch
 * fails. Supporting only one shape is a silent, total outage of this tool --
 * which is how it first shipped, because the tests only ever exercised
 * addresses that were rejected before reaching this code.
 *
 * Exported for that test.
 */
export function pinnedLookup(pinned: { address: string; family: number }) {
  return (_hostname: string, options: unknown, callback: (...args: never[]) => void): void => {
    const done = callback as unknown as (
      error: null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void;

    const wantsAll =
      typeof options === 'object' &&
      options !== null &&
      (options as { all?: boolean }).all === true;

    if (wantsAll) {
      done(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      done(null, pinned.address, pinned.family);
    }
  };
}

function requestOnce(
  target: URL,
  pinned: { address: string; family: number },
): Promise<IncomingMessage> {
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          // Identify honestly. Sites that block unknown agents should be able
          // to block this one.
          'User-Agent': 'Contexto/1.0 (+https://contextoagent.ai)',
          Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Language': 'en',
        },
        lookup: pinnedLookup(pinned),
        timeout: TIMEOUT_MS,
      },
      resolve,
    );

    req.on('timeout', () => req.destroy(new FetchRejected('That page took too long to load.')));
    req.on('error', reject);
    req.end();
  });
}

async function readBytes(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BYTES) {
      response.destroy();
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BYTES) {
      response.destroy();
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Retry a page through a residential IP when this host is refused.
 *
 * 403 and 429 from a datacenter are very often "you are a bot" rather than
 * "you may not have this" -- the same page loads fine from a home
 * connection. Only these two statuses retry, and only when an egress is
 * configured, so a genuine 404 or a paywall does not spend proxy bandwidth.
 *
 * The SSRF checks are NOT skipped on this path. They are less critical here,
 * since the proxy makes the connection and our own network is out of reach,
 * but pointing someone else's proxy at internal addresses is both rude and a
 * good way to get an account suspended.
 */
const RETRY_VIA_PROXY = new Set([403, 429]);

export async function fetchPage(
  rawUrl: string,
  transport?: typeof globalThis.fetch,
): Promise<FetchedPage> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new FetchRejected('That does not look like a web address.');
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new FetchRejected('Only http and https links can be opened.');
    }

    const pinned = await resolvePublicAddress(target.hostname);
    const response = await requestOnce(target, pinned);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400 && response.headers.location) {
      response.destroy();
      // Re-validated on the next pass, which is the point of looping rather
      // than letting the http client follow redirects for us.
      target = new URL(response.headers.location, target);
      continue;
    }

    if (status >= 400) {
      response.destroy();
      if (transport && RETRY_VIA_PROXY.has(status)) {
        return await fetchViaProxy(target, transport);
      }
      throw new FetchRejected(`That page returned an error (${status}).`);
    }

    const contentType = String(response.headers['content-type'] ?? '');

    /*
     * A linked PDF is the same kind of object as a PDF in Drive, and we
     * already extract those. Refusing it here made the answer depend on how
     * the student happened to reach the file, which is not a distinction they
     * would ever think in.
     */
    if (/^application\/pdf/i.test(contentType)) {
      const bytes = await readBytes(response);
      const extracted = await extractPdfText(new Uint8Array(bytes));
      if (!extracted.ok) {
        throw new FetchRejected(
          extracted.reason === 'unreadable'
            ? 'That PDF could not be read -- it may be password protected.'
            : 'That PDF is a scan with no text layer, so there is nothing to read.',
        );
      }
      const text = extracted.text;
      const tooLong = text.length > MAX_CHARS;
      return {
        url: target.toString(),
        title: null,
        text: tooLong ? text.slice(0, MAX_CHARS) : text,
        truncated: tooLong,
        kind: 'pdf',
      };
    }

    if (!/^text\/(html|plain)/i.test(contentType)) {
      response.destroy();
      throw new FetchRejected(
        `That link is a ${contentType.split(';')[0] || 'file'}, not a readable page.`,
      );
    }

    const body = await readBody(response);
    const text = /html/i.test(contentType) ? htmlToText(body) : body;
    const truncated = text.length > MAX_CHARS;

    return {
      url: target.toString(),
      title: /html/i.test(contentType) ? extractTitle(body) : null,
      text: truncated ? text.slice(0, MAX_CHARS) : text,
      truncated,
      kind: /html/i.test(contentType) ? 'html' : 'text',
    };
  }

  throw new FetchRejected('That link redirected too many times.');
}

/**
 * The same fetch, through someone else's IP.
 *
 * Uses plain fetch rather than the pinned-lookup path: the proxy resolves the
 * hostname itself, so pinning here would describe a connection we are not the
 * one making. The address was already validated before we got here.
 */
async function fetchViaProxy(
  target: URL,
  transport: typeof globalThis.fetch,
): Promise<FetchedPage> {
  let response: Response;
  try {
    response = await transport(target.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
        'Accept-Language': 'en',
      },
      redirect: 'follow',
    });
  } catch {
    throw new FetchRejected('That page could not be reached.');
  }

  if (!response.ok) {
    throw new FetchRejected(`That page returned an error (${response.status}).`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (/^application\/pdf/i.test(contentType)) {
    const extracted = await extractPdfText(new Uint8Array(await response.arrayBuffer()));
    if (!extracted.ok) throw new FetchRejected('That PDF could not be read.');
    const long = extracted.text.length > MAX_CHARS;
    return {
      url: target.toString(),
      title: null,
      text: long ? extracted.text.slice(0, MAX_CHARS) : extracted.text,
      truncated: long,
      kind: 'pdf',
    };
  }

  if (!/^text\/(html|plain)/i.test(contentType)) {
    throw new FetchRejected(
      `That link is a ${contentType.split(';')[0] || 'file'}, not a readable page.`,
    );
  }

  const body = (await response.text()).slice(0, MAX_BYTES);
  const isHtml = /html/i.test(contentType);
  const text = isHtml ? htmlToText(body) : body;
  const long = text.length > MAX_CHARS;

  return {
    url: target.toString(),
    title: isHtml ? extractTitle(body) : null,
    text: long ? text.slice(0, MAX_CHARS) : text,
    truncated: long,
    kind: isHtml ? 'html' : 'text',
  };
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1]).trim() || null : null;
}

/**
 * Strip a page down to its readable text.
 *
 * Deliberately not a DOM parser. The output is fed to a model that reads
 * prose perfectly well without structure, and every parser added here is
 * another dependency processing hostile input.
 */
export function htmlToText(html: string): string {
  let text = html.replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // Keep block boundaries so sentences do not run together.
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article)\s*>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[^\S\n]+/g, ' ');
  /*
   * Collapse the spaces a stripped opening tag leaves against a newline.
   * Without this a paragraph break renders as "First.\n Second.", which reads
   * as one broken line rather than as two paragraphs.
   */
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function safeCodePoint(code: number): string {
  // Malformed pages carry out-of-range references; those must not throw.
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}
