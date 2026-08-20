/**
 * What the app can actually do, independent of who is asking.
 *
 * The CLI and the window both call these. Keeping them here rather than in
 * either front end is what stops the Electron build and the `sync` command
 * drifting into two subtly different products -- the failure that would show
 * up as "it works in the terminal but not in the app".
 */

import { PortalBrowser } from './browser.mjs';
import { readCredentials, saveCredentials } from './credentials.mjs';
import { explore } from './explorer.mjs';
import { DeviceUnlinked, pushSnapshot, readConfig, writeConfig } from './sync.mjs';

/** Syncs currently running, keyed by portal. */
const inFlight = new Map();

/**
 * Run `start` for `key`, or join the run already going.
 *
 * Chrome refuses to open two instances on one profile directory, and every
 * portal has exactly one profile. So a scheduled sync overlapping a student
 * pressing "Sync now" -- or the sync fired right after a login finishing --
 * would fail on a profile lock and be recorded as if the portal were broken.
 *
 * Joining rather than refusing, because the caller wanted a fresh read and
 * one is already happening; its result is the answer they asked for.
 */
export function coalesce(map, key, start) {
  const running = map.get(key);
  if (running) return running;
  const promise = start().finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
}

export function listPortals() {
  return readConfig().portals ?? [];
}

export function status() {
  const config = readConfig();
  return {
    linked: Boolean(config.token),
    deviceName: config.deviceName ?? null,
    portals: config.portals ?? [],
  };
}

/** A stable, filesystem-safe key derived from the portal's name. */
export function portalIdFor(name, existing = []) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'portal';
  if (!existing.some((p) => p.id === base)) return base;
  let n = 2;
  while (existing.some((p) => p.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function addPortal({ name, url }) {
  const config = readConfig();
  const portals = config.portals ?? [];
  // Throwing here rather than in the UI keeps the CLI honest about it too.
  const origin = new URL(url).origin;
  const portal = { id: portalIdFor(name, portals), name, url, origin, lastSyncedAt: null };
  writeConfig({ ...config, portals: [...portals, portal] });
  return portal;
}

/**
 * Add a site and get it working, in one action.
 *
 * Adding a site and signing into it were two steps, and the gap between them
 * was where it went wrong: a site could sit in the list looking added while
 * never having fetched anything. Now the sign-in is part of adding, and the
 * result says which of the three things happened -- signed in and synced,
 * signed in but nothing there, or the site refused the sign-in.
 */
export async function addSiteWithSignIn({ name, url, username, password }) {
  const portal = addPortal({ name, url });
  try {
    saveCredentials(portal.id, { username, password });
  } catch (error) {
    removePortal(portal.id);
    throw error;
  }

  const signedIn = await autoSignIn(portal.id);
  if (!signedIn.ok) {
    return { portal, signedIn: false, reason: signedIn.reason ?? 'the site refused that sign-in' };
  }

  // Where the site actually lives is only knowable once there is a session --
  // the address a student pastes is often the sign-in page.
  const landed = await resolvePortalAddress(portal.id);
  if (!landed.needsLogin && landed.origin) {
    updatePortal(portal.id, { url: landed.url, origin: landed.origin });
  }

  const result = await syncPortal(portal.id);
  return { portal, signedIn: true, synced: true, result };
}

export function removePortal(portalId) {
  const config = readConfig();
  writeConfig({ ...config, portals: (config.portals ?? []).filter((p) => p.id !== portalId) });
}

/** Drop this machine's credential, keeping the portals it has configured. */
export function forgetDevice() {
  const { token: _token, deviceId: _deviceId, deviceName: _deviceName, ...rest } = readConfig();
  writeConfig(rest);
}

function updatePortal(portalId, patch) {
  const config = readConfig();
  writeConfig({
    ...config,
    portals: (config.portals ?? []).map((p) => (p.id === portalId ? { ...p, ...patch } : p)),
  });
}

/**
 * Find out where the portal actually lives, once there is a session.
 *
 * A student pastes the address they know, and the address they know is
 * usually the sign-in page -- which is the one page guaranteed NOT to be the
 * portal. Veracross signs you in at accounts.veracross.com and then sends you
 * to portals.veracross.com, a different origin, so locking to what was typed
 * meant the crawl could never reach anything.
 *
 * So the origin is discovered rather than declared: after logging in, follow
 * the redirects once and record where they end. Every later sync is locked to
 * that resolved origin, so this is the one moment a redirect is allowed to
 * decide where we go -- immediately after a student signed in, not during an
 * unattended background sync.
 */
export async function resolvePortalAddress(portalId) {
  const portal = listPortals().find((p) => p.id === portalId);
  if (!portal) throw new Error(`No portal called ${portalId}`);

  const browser = new PortalBrowser({ portalId, mode: 'drive', visible: false });
  try {
    await browser.launch();
    const { sessionId } = await browser.openPage('about:blank');

    const look = async (url) => {
      await browser.navigate(url, sessionId);
      // Redirect chains after SSO are several hops and partly client-side.
      await new Promise((r) => setTimeout(r, 3000));
      const { result } = await browser.cdp.send(
        'Runtime.evaluate',
        {
          expression: `JSON.stringify({
            url: location.href,
            hasPassword: Boolean(document.querySelector('input[type=password]'))
          })`,
          returnByValue: true,
        },
        sessionId,
      );
      return JSON.parse(result.value);
    };

    /*
     * Only where the pasted address ends up, deliberately.
     *
     * Falling back to the origin root when the seed shows a password field
     * looks like an improvement and is a trap: a root that serves a public
     * page has no password field either, so a signed-OUT profile resolves as
     * signed in and the next sync captures a public page as if it were the
     * student's coursework. Tested, and it did exactly that.
     *
     * A portal that keeps rendering its login form to an authenticated
     * visitor is therefore read as signed out. That is the safe direction:
     * asking someone to sign in again costs a minute, while claiming success
     * on a page holding none of their data is silently wrong.
     */
    const landed = await look(portal.url);

    const { cookies } = await browser.cdp.send('Storage.getCookies');
    const evidence = {
      cookies: cookies.length,
      google: cookies.some((c) => /google\./.test(c.domain)),
    };
    const signedOut = landed.hasPassword;
    await browser.close();

    if (signedOut) return { needsLogin: true, ...evidence };
    return { needsLogin: false, url: landed.url, origin: new URL(landed.url).origin, ...evidence };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/**
 * Sign in without the student, using a sign-in they chose to remember.
 *
 * Only works for a plain username-and-password form. A site behind Google or
 * any other SSO is deliberately out of reach: that flow is designed to detect
 * automation, and defeating it would mean teaching this app to look like
 * something it is not. Those sites keep the two-step sign-in a person does.
 *
 * The credentials are read from the keychain at the moment they are typed
 * into the page and are never written anywhere else, never logged, and never
 * sent to the server.
 */
export async function autoSignIn(portalId) {
  const portal = listPortals().find((p) => p.id === portalId);
  if (!portal) throw new Error(`No site called ${portalId}`);

  const saved = readCredentials(portalId);
  if (!saved) return { attempted: false, reason: 'no saved sign-in' };

  const browser = new PortalBrowser({ portalId, mode: 'drive', visible: false });
  try {
    await browser.launch();
    const { sessionId } = await browser.openPage(portal.url);

    const fill = `(() => {
      const pw = document.querySelector('input[type=password]');
      if (!pw) return 'no-password-field';
      const form = pw.form ?? document;
      const inputs = Array.from(form.querySelectorAll('input'));
      const before = inputs.slice(0, inputs.indexOf(pw)).reverse();
      const user = before.find((i) => /^(text|email|tel)$/.test(i.type) && !i.disabled)
        ?? form.querySelector('input[type=email], input[type=text]');
      if (!user) return 'no-username-field';
      // Assigning .value directly is invisible to React, which tracks its own
      // state -- the form would submit empty. Going through the prototype
      // setter and firing the events is what a real keystroke looks like.
      const set = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter ? setter.call(el, value) : (el.value = value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(user, ${JSON.stringify(saved.username)});
      set(pw, ${JSON.stringify(saved.password)});
      const submit = form.querySelector('button[type=submit], input[type=submit]')
        ?? Array.from(form.querySelectorAll('button')).find((b) => !b.type || b.type === 'submit');
      if (submit) submit.click();
      else if (form.requestSubmit) form.requestSubmit();
      else if (form.submit) form.submit();
      return 'submitted';
    })()`;

    const { result } = await browser.cdp.send(
      'Runtime.evaluate',
      { expression: fill, returnByValue: true },
      sessionId,
    );
    if (result.value !== 'submitted') {
      await browser.close();
      // These come back as short codes from the page script; a student should
      // read why it did not work, not the name of the thing that was missing.
      const explained = {
        'no-password-field': 'that address has no sign-in form on it',
        'no-username-field': 'the sign-in form there has no username box this could fill',
      };
      return {
        attempted: true,
        ok: false,
        reason: explained[result.value] ?? 'the sign-in form could not be filled in',
      };
    }

    // Let the sign-in land, then ask the same question a person would: are we
    // still looking at a password box?
    await new Promise((r) => setTimeout(r, 4000));
    const { result: after } = await browser.cdp.send(
      'Runtime.evaluate',
      {
        expression: 'Boolean(document.querySelector("input[type=password]"))',
        returnByValue: true,
      },
      sessionId,
    );
    await browser.close();

    const ok = after.value === false;
    if (ok) updatePortal(portalId, { loggedInAt: new Date().toISOString(), lastError: null });
    return { attempted: true, ok, reason: ok ? undefined : 'still asking for a password' };
  } catch {
    await browser.close().catch(() => {});
    // The error is deliberately not passed on: it can carry the page's own
    // text, and a failed sign-in page is exactly where a typed password can
    // end up echoed back.
    return { attempted: true, ok: false, reason: 'the sign-in could not be completed' };
  }
}

/**
 * Read a portal and push what it found.
 *
 * Values, not shapes -- this feeds the student's own agent, which cannot
 * answer "what is due Friday" from `string<date>`.
 */
export function syncPortal(portalId, options = {}) {
  return coalesce(inFlight, portalId, () => runSync(portalId, options));
}

async function runSync(portalId, { budget = 40 } = {}) {
  const config = readConfig();
  if (!config.token) throw new Error('This computer is not linked yet.');
  const portal = (config.portals ?? []).find((p) => p.id === portalId);
  if (!portal) throw new Error(`No portal called ${portalId}`);

  /*
   * A remembered sign-in makes an expired session self-healing.
   *
   * Without this the student finds out days later, when they ask the agent
   * something and it says the site needs signing into again -- which is a
   * worse way to learn it than never noticing at all.
   */
  if (!portal.loggedInAt && readCredentials(portalId)) {
    const recovered = await autoSignIn(portalId);
    if (recovered.ok) portal.loggedInAt = new Date().toISOString();
  }

  const browser = new PortalBrowser({ portalId, mode: 'drive', visible: false });
  try {
    await browser.launch();
    const { sessionId } = await browser.openPage('about:blank');
    const map = await explore(browser, sessionId, {
      origin: portal.origin,
      seed: portal.url,
      budget,
      raw: true,
    });
    await browser.close();

    await pushSnapshot(
      { apiBase: config.apiBase ?? 'https://contextoagent.ai', token: config.token },
      { portalId, origin: portal.origin, map, redacted: map.redacted },
    );

    const components = map.pages.flatMap((p) => p.components);
    const withData = components.filter((c) => c.empty === false);
    const result = {
      pages: map.pagesVisited,
      components: components.length,
      withData: withData.length,
      complete: map.complete,
      needsLogin: map.needsLogin,
      syncedAt: new Date().toISOString(),
    };
    // Clearing loggedInAt puts the portal back to offering "Sign in", which is
    // the only action that helps. Leaving it set would show a Sync button that
    // is guaranteed to fail the same way.
    updatePortal(portalId, {
      lastSyncedAt: result.syncedAt,
      lastResult: result,
      lastError: null,
      ...(map.needsLogin ? { loggedInAt: null } : {}),
    });
    return result;
  } catch (error) {
    // A browser left running holds a lock on the profile directory, so the
    // next sync would fail for a reason unrelated to what actually broke.
    await browser.close().catch(() => {});

    if (error instanceof DeviceUnlinked) {
      // Someone unlinked this computer from the web app. Dropping the token
      // returns the window to "Link this computer", which is the only thing
      // that helps; keeping it would retry every six hours forever.
      forgetDevice();
    } else {
      updatePortal(portalId, { lastError: String(error.message ?? error) });
    }
    throw error;
  }
}
