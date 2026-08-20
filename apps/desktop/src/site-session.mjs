import { WebContentsView } from 'electron';

/**
 * A browser the agent drives, inside the app.
 *
 * Replaces spawning the student's Chrome. Two reasons that is better here:
 * the student can watch it work, which matters when the thing being watched
 * is signing into their school account; and there is no second application
 * appearing on their dock, opening tabs, or fighting over a profile
 * directory.
 *
 * Each site gets its own persistent partition, so a session survives restarts
 * and no site can see another's cookies. Same isolation the separate Chrome
 * profiles gave, without the separate Chrome.
 *
 * The explorer is unchanged: this presents the same small surface it already
 * expected -- cdp.send, cdp.on, navigate -- backed by webContents.debugger
 * rather than a pipe to another process.
 */
export class SiteSession {
  /** @param {{ portalId: string, onFrame?: () => void }} options */
  constructor({ portalId }) {
    this.portalId = portalId;
    this.view = null;
    this.attached = false;
    this.listeners = new Map();
  }

  get webContents() {
    return this.view?.webContents ?? null;
  }

  async launch() {
    this.view = new WebContentsView({
      webPreferences: {
        // A site is untrusted content. No preload, no node, its own store.
        partition: `persist:site-${this.portalId}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const wc = this.view.webContents;
    wc.debugger.attach('1.3');
    this.attached = true;

    wc.debugger.on('message', (_event, method, params) => {
      for (const handler of this.listeners.get(method) ?? []) handler(params);
    });

    this.cdp = {
      send: async (method, params = {}) => wc.debugger.sendCommand(method, params),
      on: (method, handler) => {
        const list = this.listeners.get(method) ?? [];
        list.push(handler);
        this.listeners.set(method, list);
        return () => {
          const remaining = (this.listeners.get(method) ?? []).filter((h) => h !== handler);
          this.listeners.set(method, remaining);
        };
      },
    };

    return this;
  }

  /** Matches the shape the explorer already calls. */
  async openPage(url) {
    await this.navigate(url);
    return { sessionId: null };
  }

  /**
   * Navigate and wait for the page to settle.
   *
   * did-finish-load rather than a timer, with a timer as the backstop: a
   * portal that never finishes loading must not hang the whole sync.
   */
  async navigate(url, _sessionId, { timeoutMs = 30_000 } = {}) {
    const wc = this.webContents;
    if (!wc) throw new Error('This session is not open.');

    const settled = new Promise((resolve) => {
      const done = () => {
        wc.off('did-finish-load', done);
        wc.off('did-fail-load', done);
        resolve(true);
      };
      wc.once('did-finish-load', done);
      wc.once('did-fail-load', done);
    });

    await wc.loadURL(url).catch(() => {});
    return Promise.race([settled, new Promise((r) => setTimeout(() => r(false), timeoutMs))]);
  }

  /** Read something out of the page. */
  async evaluate(expression) {
    const { result } = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.value;
  }

  async close() {
    if (!this.view) return;
    try {
      if (this.attached) this.webContents?.debugger.detach();
    } catch {
      // Already detached, or the view is gone. Either way there is nothing
      // left to release.
    }
    this.attached = false;
    this.view.webContents?.close();
    this.view = null;
    this.cdp = null;
    this.listeners.clear();
  }
}
