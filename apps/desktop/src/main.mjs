import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, session, shell, Tray } from 'electron';
import {
  endSession,
  link,
  pendingWork,
  pullInput,
  pushFrame,
  readConfig,
  refreshSession,
  reportWork,
  sessionValid,
} from './sync.mjs';
import {
  clearCredentials,
  hasCredentials,
  keychainAvailable,
  saveCredentials,
} from './credentials.mjs';
import {
  autoSignIn,
  addSiteWithSignIn,
  observeSessions,
  renderBrowsersHeadless,
  browsePage,
  oneAtATime,
  setWorkingForAgent,
  removePortal,
  status,
  syncPortal,
} from './operations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env['CONTEXTO_API'] ?? 'https://contextoagent.ai';
const WEB_BASE = process.env['CONTEXTO_WEB'] ?? 'https://contextoagent.ai';

/** Six hours. Coursework changes over days, not minutes. */
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How stale a portal has to be before opening the app refreshes it.
 *
 * Without a start-up sync, a laptop that was shut for a week shows week-old
 * coursework until the first interval fires. With an unconditional one, every
 * quit-and-reopen spawns a browser and re-reads the whole portal.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * How often to ask whether the agent needs something fetched.
 *
 * Three seconds, because the agent now waits for the answer instead of
 * promising one. A minute of that wait spent before the work even starts is a
 * minute of the student watching nothing happen.
 *
 * It is a poll because the work happens on a machine that reaches out to us
 * and cannot be reached back. A tiny request every few seconds is cheaper
 * than the machinery that would avoid it, and it stops entirely when nothing
 * is linked.
 */
const WORK_POLL_MS = 3 * 1000;

let mainWindow = null;
let tray = null;
let syncing = false;

/*
 * One browser-driving pass at a time, across both loops.
 *
 * The scheduled sync and the work poll each open browsers, and between them
 * they share every piece of state that decides where a browser goes: the
 * active session, the bounds it is drawn at, and which conversation it
 * belongs to. Overlapping passes were the cause rather than a symptom -- a
 * poll firing every three seconds picked up work that was still running, and
 * the browser it opened destroyed the one halfway through reading a page, so
 * the request the student was waiting on failed while its replacement quietly
 * succeeded behind it.
 */
const drivingBrowser = oneAtATime();

/**
 * One window, two states.
 *
 * Connect this device first; after that the app IS the web app -- the same
 * pages a browser shows, because a second implementation of them would be two
 * things to keep in step. What the desktop adds is handed to that page by a
 * preload: inside the app the Sites section can add and sign into a site,
 * because there is a real browser here to drive it.
 *
 * A preload is fixed when a window is created, so linking rebuilds the
 * window rather than swapping its contents. That happens once.
 */
function showWindow() {
  const linked = status().linked;

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.showingApp === linked) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    mainWindow.destroy();
  }

  mainWindow = new BrowserWindow({
    width: linked ? 1100 : 760,
    height: linked ? 820 : 660,
    title: 'ContextoAgent',
    webPreferences: {
      preload: join(here, linked ? 'web-preload.cjs' : 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.showingApp = linked;

  if (linked) void mainWindow.loadURL(WEB_BASE);
  else void mainWindow.loadFile(join(here, 'renderer', 'index.html'));

  /*
   * Sign-in has to stay inside this window.
   *
   * Google's OAuth redirect is how the app gets its session; sending it to the
   * system browser would leave the session there and the app permanently
   * signed out. Only genuinely third-party links go outside, where there is an
   * address bar to check them against.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return '';
      }
    })();
    if (url.startsWith(WEB_BASE) || host === 'accounts.google.com') return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    /*
     * The browser was a child of that window and died with it.
     *
     * Forgetting it here is what stops the next window from being told there
     * is a page on screen when there is not: the session object outlives the
     * view inside it, so "is something showing" answered yes and the
     * conversation drew a panel around nothing. An empty frame where the page
     * used to be, which reads as the app having lost it.
     */
    stopStreaming();
    activeSession?.destroy();
    activeSession = null;
    siteViewBounds = null;
  });
}

/**
 * The menu bar item, which is what the app mostly is.
 *
 * This is a sync utility -- it should be running whether or not a window is
 * open, and closing the window should not stop portals being read. Without a
 * tray, quitting the window would either kill the sync or leave the app alive
 * with nothing on screen to show for it.
 */
function buildTray() {
  tray = new Tray(join(here, 'assets', 'tray.png'));
  tray.setToolTip('ContextoAgent');
  refreshTrayMenu();
  tray.on('click', () => showWindow());
}

function refreshTrayMenu() {
  if (!tray) return;
  const { linked, portals } = status();
  const synced = portals
    .map((p) => p.lastSyncedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: !linked
          ? 'Not linked to an account'
          : synced
            ? `Last synced ${new Date(synced).toLocaleString()}`
            : 'Never synced',
        enabled: false,
      },
      { type: 'separator' },
      { label: 'Open ContextoAgent', click: () => showWindow() },
      {
        label: syncing ? 'Syncing…' : 'Sync now',
        // Nothing to sync without a linked account or a signed-in portal, and
        // an enabled item that silently does nothing reads as a broken app.
        enabled: linked && !syncing && portals.some((p) => p.loggedInAt),
        click: () => void syncAll(),
      },
      { type: 'separator' },
      { label: 'Quit ContextoAgent', click: () => app.quit() },
    ]),
  );
}

/** Wrap a handler so a thrown error reaches the renderer as a message. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const value = await fn(...args);
      // The menu bar reflects config the renderer just changed. Only the menu
      // is refreshed here -- pushing an event back at the window that made the
      // call would loop it through its own re-render.
      refreshTrayMenu();
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
}

handle('status', () => ({
  ...status(),
  // Electron-specific, so it is read here rather than from the config file --
  // the operating system is the source of truth for this, not us.
  openAtLogin: app.getLoginItemSettings().openAtLogin,
}));
handle('setOpenAtLogin', (value) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(value), openAsHidden: true });
  return app.getLoginItemSettings().openAtLogin;
});
handle('link', async () => {
  const device = await link({ apiBase: API_BASE, webBase: WEB_BASE });
  // Linking changes which preload the window needs, so the window is rebuilt.
  // On the next tick, so this call's reply reaches the window that made it.
  setTimeout(() => showWindow(), 50);
  return device;
});
/**
 * Sign in, from inside the app.
 *
 * Two ways, cheapest first. A device that is already linked needs no browser
 * and no Google at all -- it can exchange its link for a session, which is
 * the same question already answered at linking time.
 *
 * Only when that fails does a browser open, and it is the student's own
 * browser rather than a window inside this app: it is where they are already
 * signed in, and it has an address bar to check Google's page against.
 */
handle('signIn', async () => {
  const config = readConfig();
  const apiBase = config.apiBase ?? API_BASE;

  if (config.token) {
    try {
      await refreshSession({ apiBase, token: config.token });
      reloadApp();
      return { via: 'device' };
    } catch {
      // Device revoked or offline; fall through to linking again.
    }
  }

  const device = await link({ apiBase, webBase: WEB_BASE });
  setTimeout(() => showWindow(), 50);
  return { via: 'browser', device };
});

handle('addPortal', (site) => addSiteWithSignIn(site));
handle('removePortal', (id) => removePortal(id));
handle('syncPortal', (id) => syncPortal(id));

/*
 * Saved sign-ins. The password crosses this boundary once, on its way to the
 * keychain, and never comes back out -- hasCredentials answers yes or no, and
 * nothing returns the value itself to a window.
 */
handle('saveCredentials', (id, creds) => saveCredentials(id, creds));
handle('hasCredentials', (id) => ({ saved: hasCredentials(id), available: keychainAvailable() }));
handle('clearCredentials', (id) => clearCredentials(id));
handle('autoSignIn', (id) => autoSignIn(id));

/*
 * The page reporting where its frame is. Sent on every layout change --
 * expanding, resizing, scrolling -- because a native view does not move with
 * the document and would otherwise sit where the frame used to be.
 */
/*
 * What is on screen right now, asked rather than waited for.
 *
 * Events alone lose the browser the moment a student leaves the conversation
 * and comes back -- the panel remounts having missed the message that said it
 * was there. Asking on mount is what makes it stay put.
 */
handle('siteSession', () => ({
  active: Boolean(activeSession?.working),
  showing: Boolean(activeSession?.view),
  portalId: activeSession?.portalId ?? null,
  agentId: activeSession?.agentId ?? null,
}));

handle('siteViewBounds', (bounds) => {
  siteViewBounds = bounds
    ? {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
      }
    : null;
  applySiteViewBounds();
  return { ok: true };
});

/**
 * Sync everything that has a session, quietly.
 *
 * Failures are swallowed on purpose: a portal that is down, or a login that
 * expired, must not stop the others or throw a dialog at someone who did not
 * ask for one. The window shows the last error per portal instead.
 */
async function syncAll({ onlyStale = false } = {}) {
  return drivingBrowser(() => syncAllPass({ onlyStale }));
}

async function syncAllPass({ onlyStale }) {
  syncing = true;
  refreshTrayMenu();
  for (const portal of status().portals) {
    // No session means the only useful action is signing in, which needs the
    // student. Syncing would just record the same failure again.
    if (!portal.loggedInAt) continue;
    if (onlyStale && portal.lastSyncedAt) {
      const age = Date.now() - new Date(portal.lastSyncedAt).getTime();
      if (age < STALE_AFTER_MS) continue;
    }
    try {
      await syncPortal(portal.id);
    } catch {
      /* recorded against the portal by syncPortal */
    }
    // Per portal rather than at the end, so a slow second portal does not hold
    // back the result of the first.
    notifyChanged();
  }
  syncing = false;
  refreshTrayMenu();
}

/**
 * Reload the hosted app so a new session takes effect.
 *
 * The session travels as a request header, so pages already rendered keep
 * using whatever they loaded with. Without this the student signs in
 * successfully and stares at the signed-out screen.
 */
function reloadApp() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
}

/**
 * Do what the agent asked, using a sign-in that never leaves this machine.
 *
 * This is the inversion that lets the agent reach a site without the server
 * ever holding the means to: it can leave a request, and only the computer
 * with the keychain entry can act on it.
 */
async function doPendingWork() {
  const config = readConfig();
  if (!config.token) return;
  const creds = { apiBase: config.apiBase ?? API_BASE, token: config.token };

  let work;
  try {
    work = await pendingWork(creds);
  } catch {
    return; // Offline, or the device was revoked. Nothing to do either way.
  }

  for (const item of work) {
    let outcome;
    let result;
    try {
      // Tagging the work means its browser appears in the conversation that
      // asked for it, rather than floating over whatever the student is
      // looking at.
      setWorkingForAgent(item.agentId);
      if (item.kind === 'browse') {
        result = await browsePage(item.targetUrl);
        outcome = 'read';
      } else {
        const synced = await syncPortal(item.portalId);
        outcome = synced.needsLogin ? 'needs_login' : 'synced';
      }
    } catch {
      outcome = 'failed';
    }
    setWorkingForAgent(null);
    await reportWork(creds, item.id, outcome, result).catch(() => {});
    notifyChanged();
  }
}

/**
 * The browser the agent is driving, shown inside the app.
 *
 * A native view cannot be given a CSS glow, so the page draws the frame and
 * this positions the view inside the hole it leaves. The page owns where it
 * goes and how big it is; this owns what is in it. That split is why the
 * student can expand it, drag the window, or scroll, and the view stays put
 * without any of that logic living out here.
 */
let activeSession = null;
let siteViewBounds = null;

/*
 * A click anywhere on the browser reaches the page it belongs to. The site
 * itself cannot send this -- only the preload can -- so a page cannot make
 * the panel open or close by itself.
 */
ipcMain.on('site-view-clicked', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('site-view-clicked');
});

/**
 * Carry the browser to a website that cannot hold one.
 *
 * Inside the app the student sees the real view. In a browser tab they cannot
 * -- a page may not embed these sites, every portal refuses to be framed, and
 * the browser doing the work is on this machine anyway. So the pixels go out
 * and the clicks come back.
 *
 * Only ever the newest frame. A picture that arrived while the last one was
 * still uploading is already wrong, and sending it late would put the student
 * further behind rather than closer.
 */
let streaming = null;

function startStreaming(session) {
  const config = readConfig();
  if (!config.token || !session.agentId) return;

  const creds = { apiBase: config.apiBase ?? API_BASE, token: config.token };
  const agentId = session.agentId;
  let alive = true;
  let sending = false;
  let latest = null;

  const pump = async () => {
    if (sending || !alive || !latest) return;
    sending = true;
    const frame = latest;
    latest = null;
    try {
      await pushFrame(creds, agentId, frame);
    } catch {
      // A frame that does not arrive is one the website does not paint. The
      // next repaint replaces it, and nothing about the work depends on it.
    }
    sending = false;
    void pump();
  };

  void session.startScreencast((frame) => {
    latest = frame;
    void pump();
  });

  void (async () => {
    while (alive) {
      try {
        for (const event of await pullInput(creds, agentId)) {
          if (!alive) break;
          await session.dispatchInput(event);
        }
      } catch {
        // Offline, or the server restarted mid-hold. Wait before asking
        // again so a broken connection is not a hot loop.
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  })();

  streaming = {
    stop: () => {
      alive = false;
      // Tells anyone watching that no more frames are coming, rather than
      // leaving them holding a request for a browser that has gone.
      void endSession(creds, agentId).catch(() => {});
    },
  };
}

function stopStreaming() {
  streaming?.stop();
  streaming = null;
}

/**
 * A browser the agent opened, wherever it is being rendered.
 *
 * Two things happen to it and they are independent: it goes into the window
 * if there is a window and a view to put there, and it is streamed out so a
 * website can show it. Streaming used to hang off the first, which meant that
 * closing the app window -- the ordinary state when the student is using the
 * website instead -- silently stopped the thing the website exists to show.
 */
function showSession(session) {
  attachSiteView(session);
  startStreaming(session);
}

function attachSiteView(session) {
  if (!mainWindow || mainWindow.isDestroyed() || !session?.view) return;

  // Whatever was left on screen from last time makes way for this.
  if (activeSession && activeSession !== session) {
    stopStreaming();
    mainWindow.contentView.removeChildView(activeSession.view);
    activeSession.destroy();
  }

  // Kept after the work finishes: the page the agent ended on is the evidence
  // of what it did, and it should not disappear with the spinner.
  session.keepView = true;
  session.working = true;
  activeSession = session;
  mainWindow.contentView.addChildView(session.view);
  applySiteViewBounds();
  mainWindow.webContents.send('site-session', {
    active: true,
    portalId: session.portalId,
    agentId: session.agentId,
  });
}

function applySiteViewBounds() {
  if (!activeSession?.view) return;
  /*
   * Hidden until the page says where it goes, rather than parked off-screen
   * as a ten-pixel sliver. The sliver still counted as showing, so a missing
   * bounds report looked like a browser that had loaded nothing -- an empty
   * box, which is worse than no box.
   */
  if (!siteViewBounds) {
    activeSession.view.setVisible(false);
    return;
  }
  activeSession.view.setVisible(true);
  activeSession.view.setBounds(siteViewBounds);
}

/**
 * The work is done, but the page stays.
 *
 * Only the state changes: the conversation stops showing it as working, and
 * the aura goes with that. The browser itself remains until the next piece of
 * work replaces it, or the window closes.
 */
function markSiteViewIdle() {
  if (activeSession) activeSession.working = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('site-session', {
    active: false,
    showing: Boolean(activeSession?.view),
    portalId: activeSession?.portalId,
    agentId: activeSession?.agentId,
  });
}

/** Keep the window and the menu bar showing the same thing. */
function notifyChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('portals-changed');
  refreshTrayMenu();
}

/**
 * Carry the session the link gave us into every request the page makes.
 *
 * A bearer header rather than a cookie: Better Auth signs its session cookie,
 * so writing one from here would mean reproducing that signature and keeping
 * it right forever. The bearer plugin is already enabled for exactly this,
 * and reads the same session.
 *
 * Scoped to our own origin -- an Authorization header is a credential, and it
 * has no business travelling anywhere else.
 */
function attachSession() {
  const origin = new URL(WEB_BASE).origin;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const token = readConfig().sessionToken;
    if (!token || !details.url.startsWith(origin)) return callback({});
    callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } });
  });
}

/**
 * A linked device with no session gets one before the window opens.
 *
 * Otherwise the app loads the web app signed out, and the only way back in
 * looks like signing into Google again -- which is exactly the second
 * question linking exists to avoid.
 */
async function ensureSession() {
  const config = readConfig();
  if (!config.token) return;

  const apiBase = config.apiBase ?? API_BASE;
  // Checked, not merely present: a session that expired while the app was
  // closed looks identical to a working one from here, and treating it as
  // good is how an app ends up permanently signed out with no way back.
  if (await sessionValid({ apiBase, sessionToken: config.sessionToken })) return;

  try {
    await refreshSession({ apiBase, token: config.token });
  } catch {
    // A revoked device or an offline start. The window still opens; the web
    // app will ask for a sign-in, which is the honest outcome either way.
  }
}

void app.whenReady().then(async () => {
  observeSessions({ open: showSession, close: markSiteViewIdle });
  /*
   * Offscreen whenever there is no window on screen to draw into. Chromium
   * will not composite -- and therefore cannot capture -- a view in a window
   * that is not visible, so without this a student watching from the website
   * with the app in the menu bar sees nothing at all.
   */
  renderBrowsersHeadless(() => !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible());
  attachSession();
  await ensureSession();
  showWindow();
  buildTray();
  void syncAll({ onlyStale: true });
  setInterval(() => void syncAll(), SYNC_INTERVAL_MS);
  setInterval(() => void drivingBrowser(doPendingWork), WORK_POLL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showWindow();
  });
});

/*
 * Closing the window leaves the app running in the menu bar, on every
 * platform. That is the point of a sync utility: a student who closes the
 * window still expects their coursework to keep arriving. Quit is in the tray
 * menu, where someone looking to stop it will look.
 */
app.on('window-all-closed', () => {});
