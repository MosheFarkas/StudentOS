import { createMiddleware } from 'hono/factory';
import { ContextoError } from '@contexto/shared';
import type { AppContext } from '../context.js';

export interface AuthVariables {
  userId: string;
}

/**
 * Rejects unauthenticated requests and puts the user id on the context.
 *
 * Reads the session from whatever Better Auth accepts -- a cookie from the web
 * app, or an Authorization bearer token from the desktop shell. Handlers do not
 * need to know which.
 */
export function requireAuth(ctx: AppContext) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers });

    if (!session?.user) {
      throw new ContextoError('unauthorized', 'Sign in to continue.');
    }

    c.set('userId', session.user.id);
    await next();
  });
}
