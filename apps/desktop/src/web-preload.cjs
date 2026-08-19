const { contextBridge, ipcRenderer } = require('electron');

/**
 * What the hosted web app gains by running inside the desktop app.
 *
 * The web app is loaded from contextoagent.ai and is otherwise exactly the
 * page a browser would show. This bridge is the difference: in the app, the
 * Sites section can actually add and sign into a site, because there is a
 * real browser on this machine to drive. In a browser tab the same section
 * offers the download instead, because nothing else is possible there.
 *
 * Named calls only, and no way to reach the device token or the filesystem.
 * The page is our own origin, but it is still remote content and is treated
 * as such.
 */
contextBridge.exposeInMainWorld('contextoDesktop', {
  version: 1,
  status: () => ipcRenderer.invoke('status'),
  listSites: () => ipcRenderer.invoke('status').then((r) => (r.ok ? r.value.portals : [])),
  addSite: (site) => ipcRenderer.invoke('addPortal', site),
  removeSite: (id) => ipcRenderer.invoke('removePortal', id),
  beginLogin: (id) => ipcRenderer.invoke('beginLogin', id),
  finishLogin: (id) => ipcRenderer.invoke('finishLogin', id),
  syncSite: (id) => ipcRenderer.invoke('syncPortal', id),
  onSitesChanged: (fn) => ipcRenderer.on('portals-changed', () => fn()),
});
