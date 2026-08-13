/**
 * Client environment, validated at module load.
 *
 * This exists because the failure it prevents is silent and misleading. When
 * VITE_API_BASE_URL is missing, the auth client falls back to the current
 * origin and posts to the Vite dev server instead of the API -- which surfaces
 * as a 404 from the sign-in button, pointing nowhere near the actual cause.
 *
 * Failing loudly here costs one line and saves that debugging session.
 */
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;

if (!apiBaseUrl) {
  throw new Error(
    'VITE_API_BASE_URL is not set.\n\n' +
      'Vite reads .env from the repo root via `envDir` in vite.config.ts. Check that ' +
      '/.env exists and contains VITE_API_BASE_URL, then restart the dev server -- ' +
      'Vite only reads env files at startup.',
  );
}

export const API_BASE_URL = apiBaseUrl;
