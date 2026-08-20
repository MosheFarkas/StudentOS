const { ipcRenderer } = require('electron');

/**
 * One event out, nothing in.
 *
 * The site being shown is untrusted content, so this exposes no API to it at
 * all -- with contextIsolation on, the page cannot reach ipcRenderer and has
 * no way to send anything itself. All this does is notice that the student
 * clicked somewhere on the view and say so, which is what lets the whole
 * browser act as one button instead of needing a strip along the top.
 */
document.addEventListener(
  'click',
  () => ipcRenderer.send('site-view-clicked'),
  true, // capture, so a page that stops propagation cannot swallow it
);
