/**
 * The desktop app, when we are running inside it.
 *
 * The same page is served to a browser tab and to the desktop app. Only the
 * app can sign into another site -- it has a real browser on the machine to
 * drive -- so the Sites section asks here whether that is possible, rather
 * than the two builds diverging.
 */
export interface LocalSite {
  id: string;
  name: string;
  url: string;
  origin: string;
  loggedInAt?: string | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

export interface DesktopBridge {
  version: number;
  signIn?(): Promise<{ ok: boolean; value?: { via: string }; error?: string }>;
  listSites(): Promise<LocalSite[]>;
  addSite(site: { name: string; url: string }): Promise<{ ok: boolean; error?: string }>;
  removeSite(id: string): Promise<{ ok: boolean; error?: string }>;
  beginLogin(id: string): Promise<{ ok: boolean; error?: string }>;
  finishLogin(
    id: string,
  ): Promise<{ ok: boolean; value?: { needsLogin?: boolean }; error?: string }>;
  syncSite(id: string): Promise<{ ok: boolean; error?: string }>;
  saveCredentials?(
    id: string,
    creds: { username: string; password: string },
  ): Promise<{ ok: boolean; error?: string }>;
  hasCredentials?(
    id: string,
  ): Promise<{ ok: boolean; value?: { saved: boolean; available: boolean } }>;
  clearCredentials?(id: string): Promise<{ ok: boolean }>;
  autoSignIn?(
    id: string,
  ): Promise<{ ok: boolean; value?: { ok?: boolean; reason?: string }; error?: string }>;
  onSitesChanged(fn: () => void): void;
}

declare global {
  interface Window {
    contextoDesktop?: DesktopBridge;
  }
}

export function desktop(): DesktopBridge | null {
  return typeof window !== 'undefined' ? (window.contextoDesktop ?? null) : null;
}
