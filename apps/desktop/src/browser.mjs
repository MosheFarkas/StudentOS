import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { CdpConnection } from './cdp.mjs';
import { findBrowser } from './chrome.mjs';

/**
 * Launching and holding a browser the student is logged into.
 *
 * Two rules govern everything in this file.
 *
 * 1. THE STUDENT LOGS IN TO A BROWSER WE ARE NOT DRIVING. Measured on Chrome
 *    151: `--remote-debugging-pipe` sets `navigator.webdriver = true`, while
 *    `--remote-debugging-port` leaves it false. That looks like an argument for
 *    the port, but the port is an unauthenticated TCP listener that ANY local
 *    process can connect to and use to drive a student's authenticated school
 *    portal. That exact class of hole is how researchers took over Claude's own
 *    Chrome extension in March 2026.
 *
 *    So we refuse the choice. `mode: 'login'` launches with no debugging
 *    transport at all -- an entirely ordinary browser with nothing to detect,
 *    which matters because Google answers automation signals on its sign-in
 *    page with "This browser or app may not be secure." Once the student has
 *    authenticated, `mode: 'drive'` reopens the same profile over the pipe to
 *    read data. Pages behind a login do not re-run those checks, so we never
 *    have to spoof a signal to get past one.
 *
 * 2. A DEDICATED PROFILE, NEVER THE DEFAULT ONE. Since Chrome 136, remote
 *    debugging is refused outright on the default profile, specifically to stop
 *    cookie theft. That restriction is load-bearing for us rather than an
 *    obstacle: it means this code physically cannot reach the student's real
 *    Chrome, where they are signed into Gmail, Drive and Classroom. Those stay
 *    behind OAuth, where the scope model in packages/agent governs them. This
 *    profile only ever holds a school-portal session.
 */

const PROFILE_ROOT =
  {
    darwin: () => join(homedir(), 'Library', 'Application Support', 'ContextoAgent', 'portals'),
    win32: () => join(process.env['APPDATA'] ?? homedir(), 'ContextoAgent', 'portals'),
  }[platform()] ?? (() => join(homedir(), '.config', 'contexto-agent', 'portals'));

export function profileDirFor(portalId) {
  if (!/^[a-z0-9-]+$/.test(portalId)) throw new Error(`Invalid portal id: ${portalId}`);
  return join(PROFILE_ROOT(), portalId);
}

export class PortalBrowser {
  /** @param {{ portalId: string, visible?: boolean, mode?: 'login'|'drive', startUrl?: string }} options */
  constructor({ portalId, visible = true, mode = 'drive', startUrl = null }) {
    this.portalId = portalId;
    this.visible = visible;
    this.mode = mode;
    this.startUrl = startUrl;
    this.profileDir = profileDirFor(portalId);
    this.process = null;
    this.cdp = null;
  }

  async launch() {
    const browser = findBrowser();
    mkdirSync(this.profileDir, { recursive: true });

    const driving = this.mode === 'drive';
    const args = [
      ...(driving ? ['--remote-debugging-pipe'] : []),
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Headless also sets navigator.webdriver, and stamps "Headless" into the
      // user agent besides. When we need to read without showing a window, we
      // put the window off the edge of the desktop instead.
      ...(this.visible ? [] : ['--window-position=-32000,-32000']),
      this.startUrl ?? 'about:blank',
    ];

    this.process = spawn(browser.path, args, {
      stdio: driving ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
    });

    // Chrome refuses to start at all when an administrator sets the
    // RemoteDebuggingAllowed policy to false, which is plausible on a
    // school-managed laptop. Capture stderr so the failure names itself
    // instead of surfacing as a timeout.
    let stderr = '';
    this.process.stderr?.on('data', (chunk) => (stderr += chunk.toString()));

    const exited = new Promise((_, reject) => {
      this.process.once('exit', (code) => reject(new Error(diagnoseExit(code, stderr, browser))));
    });

    this.browserBrand = browser.brand;
    if (!driving) {
      // There is nothing to connect to, by design. Give a policy failure a
      // moment to surface, then hand the window to the student.
      await Promise.race([new Promise((r) => setTimeout(r, 1200)), exited]);
      return this;
    }

    this.cdp = new CdpConnection(this.process.stdio[3], this.process.stdio[4]);
    const version = await Promise.race([this.cdp.send('Browser.getVersion'), exited]);
    this.product = version.product;
    return this;
  }

  /**
   * Open a page, attach to it, and wait for the load event.
   *
   * The wait is not a nicety. Attaching returns as soon as the target exists,
   * while the document is still about:blank, so anything that reads
   * document.cookie or the DOM straight afterwards gets an empty answer -- which
   * is indistinguishable from a login that did not persist.
   */
  async openPage(url, { timeoutMs = 30_000 } = {}) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const sessionId = await this.cdp.attachToTarget(targetId);
    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);
    await this.navigate(url, sessionId, { timeoutMs });
    return { targetId, sessionId };
  }

  /** Navigate an attached page, resolving once its load event has fired. */
  async navigate(url, sessionId, { timeoutMs = 30_000 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.cdp.on(
        'Page.loadEventFired',
        () => {
          off();
          resolve(true);
        },
        sessionId,
      );
    });
    await this.cdp.send('Page.navigate', { url }, sessionId);
    return Promise.race([loaded, new Promise((r) => setTimeout(() => r(false), timeoutMs))]);
  }

  async currentUrl(sessionId) {
    const { result } = await this.cdp.send(
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
      sessionId,
    );
    return result.value;
  }

  async close() {
    if (!this.process) return;
    const dead = new Promise((resolve) => this.process.once('exit', resolve));
    if (!this.cdp) {
      // Login mode has no protocol channel. SIGTERM lets Chrome run its normal
      // shutdown and flush the cookie store; SIGKILL would discard the login
      // the student just completed.
      this.process.kill('SIGTERM');
      await Promise.race([dead, new Promise((r) => setTimeout(r, 8000))]);
      this.process = null;
      return;
    }
    try {
      // Ask Chrome to shut down so it flushes cookies to the profile. Killing
      // the process loses the session the student just logged in to create.
      await this.cdp.send('Browser.close');
    } catch {
      this.process.kill();
    }
    await Promise.race([dead, new Promise((r) => setTimeout(r, 5000))]);
    this.process = null;
  }
}

export function diagnoseExit(code, stderr, browser = { brand: 'chrome' }) {
  if (/remote debugging.*(disallowed|not allowed)/i.test(stderr)) {
    return (
      'Your school administrator has disabled remote debugging in this browser ' +
      '(Chrome policy RemoteDebuggingAllowed). Contexto cannot read your portal ' +
      'on this device. Try your personal computer.'
    );
  }
  if (/user data directory.*in use|ProcessSingleton/i.test(stderr)) {
    return 'That portal is already open in another Contexto window. Close it and try again.';
  }
  return `${browser.brand} exited with code ${code} before Contexto could connect.${
    stderr ? ` Details: ${stderr.trim().slice(0, 300)}` : ''
  }`;
}
