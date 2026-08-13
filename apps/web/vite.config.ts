import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * A plain SPA build -- no SSR, no server runtime.
 *
 * That is a deliberate constraint, not an oversight: the same `dist/` that the
 * droplet serves can be loaded by a desktop shell later. Introducing anything
 * that needs a Node server at render time (server components, SSR-only routing)
 * closes off the Mac app.
 */
export default defineConfig({
  plugins: [react()],

  /*
   * Read .env from the monorepo root, not from apps/web.
   *
   * Vite defaults envDir to its own project root, so without this it silently
   * finds no .env and every VITE_* variable is undefined in the browser. The
   * failure is nasty because it is silent: the auth client falls back to the
   * current origin and posts to the Vite dev server instead of the API, which
   * looks like a 404 from the sign-in button rather than a config problem.
   *
   * The API solves the same problem by walking up from its own file to find
   * the root .env (apps/api/src/env.ts); this is Vite's equivalent.
   */
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  server: {
    port: 5173,
    /*
     * Fail rather than drift to the next free port.
     *
     * The port is baked into three places that must agree: WEB_BASE_URL (which
     * drives the API's CORS allowlist), Better Auth's trustedOrigins, and the
     * authorised JavaScript origin registered with Google. A silent hop to
     * 5174 breaks sign-in and every API call with errors that point nowhere
     * near the actual cause -- much better to refuse to start.
     */
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
