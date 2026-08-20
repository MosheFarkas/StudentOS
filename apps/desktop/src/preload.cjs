const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire surface the window is allowed to reach.
 *
 * Named calls only -- no generic "invoke whatever channel you like", which
 * would hand any injected script the same reach as the app itself. The
 * renderer loads only local files today, but this boundary is what keeps that
 * from being a load-bearing assumption.
 */
contextBridge.exposeInMainWorld('contexto', {
  status: () => ipcRenderer.invoke('status'),
  link: () => ipcRenderer.invoke('link'),
  signIn: () => ipcRenderer.invoke('signIn'),
  addPortal: (portal) => ipcRenderer.invoke('addPortal', portal),
  removePortal: (id) => ipcRenderer.invoke('removePortal', id),
  syncPortal: (id) => ipcRenderer.invoke('syncPortal', id),
  saveCredentials: (id, creds) => ipcRenderer.invoke('saveCredentials', id, creds),
  hasCredentials: (id) => ipcRenderer.invoke('hasCredentials', id),
  clearCredentials: (id) => ipcRenderer.invoke('clearCredentials', id),
  autoSignIn: (id) => ipcRenderer.invoke('autoSignIn', id),
  setOpenAtLogin: (value) => ipcRenderer.invoke('setOpenAtLogin', value),
  onPortalsChanged: (fn) => ipcRenderer.on('portals-changed', () => fn()),
});
