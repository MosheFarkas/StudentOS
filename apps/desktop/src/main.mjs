import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, shell, Tray } from 'electron';
import { link } from './sync.mjs';
import {
  addPortal,
  beginLogin,
  finishLogin,
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

let mainWindow = null;
let tray = null;
let syncing = false;

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
handle('addPortal', (portal) => addPortal(portal));
handle('removePortal', (id) => removePortal(id));
handle('beginLogin', (id) => beginLogin(id));
handle('finishLogin', (id) => finishLogin(id));
handle('syncPortal', (id) => syncPortal(id));

/**
 * Sync everything that has a session, quietly.
 *
 * Failures are swallowed on purpose: a portal that is down, or a login that
 * expired, must not stop the others or throw a dialog at someone who did not
 * ask for one. The window shows the last error per portal instead.
 */
async function syncAll({ onlyStale = false } = {}) {
  if (syncing) return;
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

/** Keep the window and the menu bar showing the same thing. */
function notifyChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('portals-changed');
  refreshTrayMenu();
}

void app.whenReady().then(() => {
  showWindow();
  buildTray();
  void syncAll({ onlyStale: true });
  setInterval(() => void syncAll(), SYNC_INTERVAL_MS);

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
