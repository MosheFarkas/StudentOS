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
