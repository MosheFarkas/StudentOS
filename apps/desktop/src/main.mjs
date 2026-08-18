import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
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

let window = null;

function createWindow() {
  window = new BrowserWindow({
    width: 720,
    height: 620,
    title: 'ContextoAgent',
    webPreferences: {
      // This process drives a browser holding school logins and holds a token
      // that speaks for the student's account. The renderer gets none of that:
      // no Node, an isolated context, and only the calls named in preload.
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadFile(join(here, 'renderer', 'index.html'));

  // A link in this UI is a real web page; it belongs in the student's own
  // browser, not in a chromeless window with no address bar to check.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Wrap a handler so a thrown error reaches the renderer as a message. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
}

handle('status', () => status());
handle('link', () => link({ apiBase: API_BASE, webBase: WEB_BASE }));
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
async function syncAll() {
  for (const portal of status().portals) {
    if (!portal.loggedInAt) continue;
    try {
      await syncPortal(portal.id);
    } catch {
      /* recorded against the portal by syncPortal */
    }
  }
  window?.webContents.send('portals-changed');
}

void app.whenReady().then(() => {
  createWindow();
  setInterval(() => void syncAll(), SYNC_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
