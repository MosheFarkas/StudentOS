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
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
