import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createContext } from './context.js';
import { handleError } from './errors.js';
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

app.onError(handleError);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

export type { AppRoutes } from './routes/index.js';
