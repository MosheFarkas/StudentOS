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
}

export class FetchRejected extends Error {}

/** True for anything that must never be reachable from our server. */
function isForbiddenAddress(ip: string): boolean {
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
  // IPv4-mapped IPv6 smuggles the whole v4 problem back in.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (mapped?.[1]) return isForbiddenAddress(mapped[1]);
  return false;
}

/** Resolve, and reject unless EVERY answer is a public address. */
async function resolvePublicAddress(
  hostname: string,
): Promise<{ address: string; family: number }> {
  if (isIP(hostname) !== 0) {
    if (isForbiddenAddress(hostname)) {
      throw new FetchRejected('That address is not allowed.');
    }
    return { address: hostname, family: isIP(hostname) };
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await dnsLookup(hostname, { all: true });
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

export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
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
    };
  }

  throw new FetchRejected('That link redirected too many times.');
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
