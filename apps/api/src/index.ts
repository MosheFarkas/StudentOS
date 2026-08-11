import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';
import { StudentOsError, type ApiError } from '@studentos/shared';
import { createContext } from './context.js';
import { loadEnv } from './env.js';
import { createRoutes } from './routes/index.js';

const env = loadEnv();
const ctx = createContext(env);

const app = new Hono();

/**
 * CORS.
 *
 * `credentials: true` is what lets the web app send its session cookie. The
 * desktop shell will need its own origin added here -- an Electron renderer
 * loading a local file reports `Origin: null`, which is why this is an explicit
 * list rather than a wildcard.
 */
app.use(
  '*',
  cors({
    origin: [env.WEB_BASE_URL],
    credentials: true,
  }),
);

/** Better Auth owns everything under /api/auth. */
app.on(['GET', 'POST'], '/api/auth/*', (c) => ctx.auth.handler(c.req.raw));

app.route('/api', createRoutes(ctx));

app.onError((error, c) => {
  if (error instanceof StudentOsError) {
    const body: ApiError = { code: error.code, message: error.message };
    return c.json(body, statusFor(error.code));
  }

  if (error instanceof ZodError) {
    const body: ApiError = { code: 'validation_failed', message: error.issues[0]?.message ?? '' };
    return c.json(body, 400);
  }

  // Never surface an unexpected error's message -- decryption failures and
  // upstream provider errors can contain key material.
  console.error('Unhandled error', error);
  const body: ApiError = { code: 'internal_error', message: 'Something went wrong.' };
  return c.json(body, 500);
});

function statusFor(code: ApiError['code']): 400 | 401 | 402 | 404 | 500 {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'not_found':
      return 404;
    case 'validation_failed':
    case 'provider_key_invalid':
      return 400;
    case 'quota_exceeded':
    case 'no_provider_configured':
      return 402;
    default:
      return 500;
  }
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

export type { AppRoutes } from './routes/index.js';
