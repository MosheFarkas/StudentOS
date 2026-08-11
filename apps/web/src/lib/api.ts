import { hc } from 'hono/client';
import type { AppRoutes } from '@studentos/api/types';

/**
 * Typed API client.
 *
 * Types come straight from the API's route definitions, so a handler signature
 * change is a compile error here rather than a runtime surprise. There is no
 * codegen step and no hand-maintained duplicate of the API's types.
 */
export const api = hc<AppRoutes>(`${import.meta.env.VITE_API_BASE_URL}/api`, {
  init: { credentials: 'include' },
});
