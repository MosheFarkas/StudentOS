import { createMiddleware } from 'hono/factory';
import { ContextoError } from '@contexto/shared';

/**
 * A small brake for unauthenticated routes.
 *
 * Held in memory, so it is per-process and resets on deploy. That is a real
 * limitation and it is the right trade here: the only route that needs it
 * creates a short-lived row and the API runs as a single process, so a
 * shared store would be new infrastructure guarding one endpoint. If this
 * ever needs to hold across instances, it moves to the database.
 *
 * The point is not to stop a determined attacker -- it is to keep an
 * unauthenticated endpoint that writes rows from being trivially spammable.
 */
const hits = new Map<string, number[]>();

export function rateLimit({ limit, windowMs }: { limit: number; windowMs: number }) {
  return createMiddleware(async (c, next) => {
    // Behind a proxy the socket address is the proxy, so prefer the forwarded
    // header. It is spoofable, which is why this is a brake and not a
    // security boundary.
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    const key = forwarded || c.req.header('cf-connecting-ip') || 'unknown';

    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);

    if (recent.length >= limit) {
      hits.set(key, recent);
      throw new ContextoError('rate_limited', 'Too many attempts. Wait a moment and try again.');
    }

    recent.push(now);
    hits.set(key, recent);

    // Entries expire by time, so the map would otherwise grow with every new
    // address seen. Swept opportunistically rather than on a timer.
    if (hits.size > 5_000) {
      for (const [k, times] of hits) {
        if (times.every((at) => now - at >= windowMs)) hits.delete(k);
      }
    }

    await next();
  });
}

/** Test seam: the window is time-based, so tests would otherwise have to wait. */
export function resetRateLimits() {
  hits.clear();
}
