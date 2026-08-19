/**
 * What the app can actually do, independent of who is asking.
 *
 * The CLI and the window both call these. Keeping them here rather than in
 * either front end is what stops the Electron build and the `sync` command
 * drifting into two subtly different products -- the failure that would show
 * up as "it works in the terminal but not in the app".
 */

import { PortalBrowser } from './browser.mjs';
import { explore } from './explorer.mjs';
import { DeviceUnlinked, pushSnapshot, readConfig, writeConfig } from './sync.mjs';

/** Login windows currently open, keyed by portal. Not persisted. */
const openLogins = new Map();

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
 * Open a browser for the student to log in with.
 *
 * Deliberately not awaited to completion: there is no way to detect "the
 * student has finished logging in" from outside, and guessing would close the
 * window mid two-factor. The caller signals completion instead.
 */
export async function beginLogin(portalId) {
  const portal = listPortals().find((p) => p.id === portalId);
  if (!portal) throw new Error(`No portal called ${portalId}`);
  if (openLogins.has(portalId)) return { alreadyOpen: true };

  const browser = new PortalBrowser({ portalId, mode: 'login', startUrl: portal.url });
  await browser.launch();
  openLogins.set(portalId, browser);
  return { alreadyOpen: false };
}

/** Close the login window gracefully, which is what persists the session. */
export async function finishLogin(portalId) {
  const browser = openLogins.get(portalId);
  if (!browser) return { closed: false };
  openLogins.delete(portalId);
  await browser.close();
  updatePortal(portalId, { loggedInAt: new Date().toISOString() });
  return { closed: true };
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
