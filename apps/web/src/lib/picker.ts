/**
 * The Google Picker: how a student hands a file to their agent.
 *
 * drive.file grants no access on its own. It only becomes access when the
 * student selects a specific file here, which is exactly why the scope is
 * non-sensitive and needs no security assessment -- see
 * packages/agent/src/tools/google/scopes.ts.
 *
 * The token used below is requested fresh from Google for drive.file ALONE,
 * rather than reusing the server's Google token. The server's token carries
 * every scope the student has granted -- calendar write included -- and
 * handing that to the browser would widen what an XSS in this app could do,
 * for no benefit. This token can do nothing but read picked files.
 */

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';

/** Only the surface we use, so no @types packages for two call sites. */
interface TokenResponse {
  access_token?: string;
  error?: string;
}
export interface PickerDoc {
  id: string;
  name?: string;
  mimeType?: string;
}
interface GoogleGlobal {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: unknown) => void;
      }): { requestAccessToken(options?: { prompt?: string }): void };
    };
  };
  picker: {
    Action: { PICKED: string; CANCEL: string };
    Feature: { MULTISELECT_ENABLED: string };
    DocsView: new (viewId?: unknown) => PickerView;
    ViewId: { DOCS: unknown };
    PickerBuilder: new () => PickerBuilder;
  };
}
interface PickerView {
  setIncludeFolders(value: boolean): PickerView;
  setSelectFolderEnabled(value: boolean): PickerView;
  setOwnedByMe(value: boolean): PickerView;
}
interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(callback: (data: { action: string; docs?: PickerDoc[] }) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

declare global {
  interface Window {
    google?: GoogleGlobal;
    gapi?: { load(name: string, callback: () => void): void };
  }
}

export const CLIENT_ID: string | undefined = import.meta.env.VITE_GOOGLE_CLIENT_ID;
export const PICKER_API_KEY: string | undefined = import.meta.env.VITE_GOOGLE_PICKER_API_KEY;

/**
 * Whether the Picker can run at all.
 *
 * Both values come from the Google Cloud console and are set per deployment.
 * Missing config is a deployment state, not a bug, so this is reported in the
 * UI rather than thrown the way lib/env.ts throws for the API URL -- the rest
 * of Settings must keep working.
 */
export function pickerConfigured(): boolean {
  return Boolean(CLIENT_ID && PICKER_API_KEY);
}

const loaded = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const existing = loaded.get(src);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });

  loaded.set(src, promise);
  return promise;
}

/** Request a drive.file-only access token, without re-prompting if granted. */
async function requestDriveToken(): Promise<string> {
  await loadScript(GSI_SRC);
  const google = window.google;
  if (!google) throw new Error('Google sign-in library did not load.');

  return new Promise<string>((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID as string,
      scope: DRIVE_FILE_SCOPE,
      callback: (response) => {
        if (response.access_token) resolve(response.access_token);
        else reject(new Error(response.error ?? 'Google did not return a token.'));
      },
      error_callback: () => reject(new Error('Google sign-in was closed.')),
    });

    // Empty prompt: silent when the student has already granted drive.file,
    // which they have, because connecting Drive is a prerequisite for this.
    client.requestAccessToken({ prompt: '' });
  });
}

/**
 * Open the Picker. Resolves with the files the student chose.
 *
 * Resolves EMPTY when they cancel, rather than rejecting -- cancelling is a
 * normal thing to do and should not surface as an error.
 */
export async function pickDriveFiles(): Promise<PickerDoc[]> {
  if (!pickerConfigured()) {
    throw new Error('File picking is not configured for this deployment.');
  }

  const token = await requestDriveToken();

  await loadScript(GAPI_SRC);
  const gapi = window.gapi;
  if (!gapi) throw new Error('Google API library did not load.');
  await new Promise<void>((resolve) => gapi.load('picker', resolve));

  const google = window.google;
  if (!google?.picker) throw new Error('Google Picker did not load.');
  const picker = google.picker;

  return new Promise<PickerDoc[]>((resolve) => {
    /*
     * Two views, because Classroom materials live in NEITHER by default.
     * Teacher-posted files are owned by the teacher and shared with the
     * student, so they appear under "Shared with me" and not in My Drive --
     * offering only the default view would hide the exact files this feature
     * exists to read.
     */
    /*
     * Folders are selectable, not just visible. Picking a course folder is one
     * action instead of one per handout. Whether Drive then grants the files
     * inside is Google's call -- the server asks and degrades quietly if not,
     * see expandFolders in packages/agent/src/tools/google/drive.ts.
     */
    const sharedWithMe = new picker.DocsView(picker.ViewId.DOCS)
      .setOwnedByMe(false)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true);
    const myDrive = new picker.DocsView(picker.ViewId.DOCS)
      .setOwnedByMe(true)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true);

    const built = new picker.PickerBuilder()
      .setTitle('Choose files your agent can read')
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(PICKER_API_KEY as string)
      .addView(sharedWithMe)
      .addView(myDrive)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) resolve(data.docs ?? []);
        else if (data.action === picker.Action.CANCEL) resolve([]);
      })
      .build();

    built.setVisible(true);
  });
}
