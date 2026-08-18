import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { devices } from '@contexto/db';
import { ContextoError } from '@contexto/shared';
import type { AppContext } from '../context.js';

export interface DeviceVariables {
  userId: string;
  deviceId: string;
}

/** Tokens are compared by hash, so the plaintext never has to be stored. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Authenticates a desktop companion by bearer token.
 *
 * Separate from requireAuth on purpose. A device token is not a session: it
 * belongs to one machine, it is revocable on its own, and it must never be
 * accepted where a browser session is expected. Keeping the two middlewares
 * apart means a route has to opt in to device access explicitly rather than
 * inheriting it.
 */
export function requireDevice(ctx: AppContext) {
  return createMiddleware<{ Variables: DeviceVariables }>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      throw new ContextoError('unauthorized', 'This device is not linked.');
    }

    const [device] = await ctx.db
      .select({ id: devices.id, userId: devices.userId })
      .from(devices)
      .where(and(eq(devices.tokenHash, hashDeviceToken(token)), isNull(devices.revokedAt)))
      .limit(1);

    if (!device) {
      throw new ContextoError('unauthorized', 'This device is not linked.');
    }

    c.set('userId', device.userId);
    c.set('deviceId', device.id);
    await ctx.db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id));
    await next();
  });
}
