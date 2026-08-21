import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BrowserWindow, WebContentsView } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));

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
  /** @param {{ portalId: string, agentId?: string|null, headless?: boolean }} options */
  constructor({ portalId, agentId = null, headless = false }) {
    this.portalId = portalId;
    /** Which conversation this belongs to, or null for a scheduled sync. */
    this.agentId = agentId;
    /**
     * Rendered where nobody is looking.
     *
     * A view only produces pictures while something is compositing it, and
     * nothing composites a view inside a window that is not on screen --
     * measured: a hidden window yields zero frames, and capturePage on one
     * hangs. So when the app has no window open and the student is watching
     * from the website instead, the page is rendered in an offscreen window,
     * which Chromium draws precisely so that it can be captured.
     *
     * The cost is that an offscreen window cannot also be shown inside the
     * app -- it is not a child view -- which is exactly why this is a mode
     * rather than the default.
     */
    this.headless = headless;
    /** Set by whoever is showing it, to keep the page up after the work ends. */
    this.keepView = false;
    this.view = null;
    this.window = null;
    this.attached = false;
    this.listeners = new Map();
    /** Set once someone wants pictures; the stream starts at the first page. */
    this.onFrame = null;
    this.casting = false;
    this.everLoaded = false;
  }

  get webContents() {
    return (this.headless ? this.window?.webContents : this.view?.webContents) ?? null;
  }

  async launch() {
    /*
     * The site is untrusted content and is treated as such: its own store,
     * no node, an isolated world. The preload exposes nothing to the page
     * -- it only reports that the student clicked, which is what lets the
     * whole view act as one button rather than needing a strip along the
     * top to press.
     */
    const webPreferences = {
      preload: join(here, 'site-view-preload.cjs'),
      partition: `persist:site-${this.portalId}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    };

    if (this.headless) {
      this.window = new BrowserWindow({
        show: false,
        width: 1000,
        height: 700,
        webPreferences: { ...webPreferences, offscreen: true },
      });
      // Offscreen rendering paints on demand; without a rate it paints once
      // and the stream looks frozen the moment anything moves.
      this.window.webContents.setFrameRate(10);
    } else {
      this.view = new WebContentsView({ webPreferences });
    }

    const wc = this.webContents;
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

  /**
   * Stream what the page looks like, frame by frame.
   *
   * A browser tab cannot be handed this view and is not allowed to embed the
   * sites involved -- every portal worth showing refuses to be framed -- so
   * the pixels are carried instead. This is the same mechanism DevTools uses
   * to mirror a remote device, which is why it is a stream of JPEGs rather
   * than a screenshot loop: frames arrive when the page actually repaints, so
   * a page sitting still costs nothing at all.
   *
   * Every frame must be acknowledged or the protocol stops sending them.
   */
  async startScreencast(onFrame) {
    if (!this.cdp || this.onFrame) return;
    this.onFrame = onFrame;

    this.cdp.on('Page.screencastFrame', (params) => {
      // Acked first and unconditionally. A frame we fail to pass on is one
      // dropped picture; a frame we fail to ack ends the stream.
      void this.cdp
        ?.send('Page.screencastFrameAck', { sessionId: params.sessionId })
        .catch(() => {});
      try {
        onFrame({
          data: params.data,
          width: params.metadata?.deviceWidth ?? 0,
          height: params.metadata?.deviceHeight ?? 0,
        });
      } catch {
        // A consumer that throws must not take the stream down with it.
      }
    });

    // Deferred until there is a page. Asking a blank offscreen window to
    // start casting never returns -- measured: the call sat unresolved until
    // the window was destroyed, which took the whole feature down silently.
    if (this.everLoaded) await this.beginCast();
  }

  /** Actually turn the stream on. Safe to call more than once. */
  async beginCast() {
    if (this.casting || !this.cdp || !this.onFrame) return;
    this.casting = true;

    await this.cdp.send('Page.enable').catch(() => {});
    await this.cdp
      .send('Page.startScreencast', {
        format: 'jpeg',
        // Sized and compressed for a thing being watched, not archived. The
        // student is checking that it is doing the right thing, not reading
        // fine print -- and every byte here crosses their connection twice.
        quality: 55,
        maxWidth: 1000,
        maxHeight: 700,
        everyNthFrame: 1,
      })
      .catch(() => {});
  }

  /**
   * Replay something the student did on the website, in the real page.
   *
   * Enumerated rather than forwarded. This is a debugger attached to a
   * browser holding a school login, so what the far end may say is a short
   * list -- pointer, wheel, keys -- and nothing that navigates or evaluates.
   */
  async dispatchInput(event) {
    if (!this.cdp) return;
    try {
      if (event.kind === 'mouse') {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: event.type,
          x: event.x,
          y: event.y,
          button: event.button,
          clickCount: event.clickCount,
        });
      } else if (event.kind === 'wheel') {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: event.x,
          y: event.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        });
      } else if (event.kind === 'key') {
        /*
         * Only 'char' carries text, whatever the caller sent.
         *
         * The protocol inserts a character for any event that has `text`, so
         * a keyDown-with-text followed by the matching char types it twice --
         * measured, not guessed: one press of "h" produced "hh". Keys that
         * print do so on char; keys that do not print, like Backspace and
         * Enter, act on keyDown and need no text at all.
         */
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: event.type,
          key: event.key,
          code: event.code,
          ...(event.type === 'char' && event.text ? { text: event.text } : {}),
        });
      }
    } catch {
      // The page navigated out from under it, or the session is closing.
      // A lost click is not worth failing the work the agent is doing.
    }
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
    const finished = await Promise.race([
      settled,
      new Promise((r) => setTimeout(() => r(false), timeoutMs)),
    ]);

    // There is a page now, so anything waiting to stream one can begin.
    this.everLoaded = true;
    void this.beginCast();

    return finished;
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

  /**
   * Finish with the page, and usually leave it on screen.
   *
   * The last thing the agent looked at is worth keeping: a browser that
   * vanishes the moment it stops takes the evidence with it, and "what did it
   * actually read" is a fair question after the fact as well as during. The
   * protocol connection is always released -- nothing is driving it any more
   * -- but the view stays until something replaces it.
   */
  async close() {
    if (!this.view) return;
    try {
      if (this.attached) this.webContents?.debugger.detach();
    } catch {
      // Already detached, or the view is gone. Either way there is nothing
      // left to release.
    }
    this.attached = false;
    this.cdp = null;
    this.listeners.clear();

    if (this.keepView) return;
    this.destroy();
  }

  /** Actually take it down. */
  destroy() {
    try {
      this.view?.webContents?.close();
      // An offscreen window is a window: closing its contents is not enough,
      // and one left behind keeps rendering a page nobody is watching.
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
    } catch {
      // Already gone.
    }
    this.view = null;
    this.window = null;
  }
}
