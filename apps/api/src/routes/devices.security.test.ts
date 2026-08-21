import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { portalSnapshots } from '@contexto/db';
import { createAuth } from '../auth.js';
import { handleError } from '../errors.js';
import { createRoutes } from './index.js';
import type { AppContext } from '../context.js';
import { LiveSessions } from '../live-session.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { createUser, reset, testDb, TEST_DATABASE_URL } from '../test-support/harness.js';

/**
 * Adversarial checks on the device surface.
 *
 * These are the ways in, tried deliberately. Every one of them describes
 * something that would be a real incident for a student -- another person's
 * coursework, a credential doing a job it was never granted, or a value from
 * a machine we do not control reaching somewhere it should not.
 */

let app: Hono;
let db: Awaited<ReturnType<typeof testDb>>;

beforeAll(async () => {
  db = await testDb();
  const env = {
    NODE_ENV: 'test' as const,
    PORT: 0,
    DATABASE_URL: TEST_DATABASE_URL,
    API_BASE_URL: 'http://localhost:3000',
    WEB_BASE_URL: 'http://localhost:5173',
    AUTH_SECRET: 'x'.repeat(40),
    MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
  };
  const ctx = {
    env,
    db,
    auth: createAuth(db, env as never),
    telegram: undefined,
    // Real, not stubbed: it is in-memory anyway, and the routes under test
    // are the ones that read and write it.
    live: new LiveSessions(),
  } as unknown as AppContext;
  app = new Hono().route('/api', createRoutes(ctx)).onError(handleError);
});

beforeEach(async () => {
  resetRateLimits();
  await reset();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const post = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? bearer(token) : {}) },
  body: JSON.stringify(body),
});

async function linked(userToken: string) {
  const start = await app.request('/api/devices/link/start', post({ deviceName: 'Mac' }));
  const { requestId } = (await start.json()) as { requestId: string };
  await app.request(`/api/devices/link/${requestId}/approve`, post({}, userToken));
  const claim = await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' });
  return (await claim.json()) as { token: string; deviceId: string; sessionToken: string };
}

const snapshot = (over: Record<string, unknown> = {}) => ({
  portalId: 'veracross',
  origin: 'https://portals.veracross.com',
  redacted: false,
  capturedAt: new Date().toISOString(),
  map: { pages: [] },
  ...over,
});

describe('credentials cannot swap jobs', () => {
  it('a session token cannot push a snapshot', async () => {
    // Only a device may write portal data. A browser session doing so would
    // mean a stolen session could poison what the agent reads.
    const alice = await createUser();
    const device = await linked(alice.token);
    const res = await app.request(
      '/api/devices/portal-snapshot',
      post(snapshot(), device.sessionToken),
    );
    expect(res.status).toBe(401);
  });

  it('a device token cannot switch a site off', async () => {
    const alice = await createUser();
    const device = await linked(alice.token);
    const res = await app.request(
      '/api/devices/sites/veracross/enabled',
      post({ enabled: false }, device.token),
    );
    expect(res.status).toBe(401);
  });

  it('a device token cannot delete a site', async () => {
    const alice = await createUser();
    const device = await linked(alice.token);
    const res = await app.request('/api/devices/sites/veracross', {
      method: 'DELETE',
      headers: bearer(device.token),
    });
    expect(res.status).toBe(401);
  });

  it('a device token cannot revoke devices', async () => {
    const alice = await createUser();
    const device = await linked(alice.token);
    const res = await app.request(`/api/devices/${device.deviceId}/revoke`, post({}, device.token));
    expect(res.status).toBe(401);
  });
});

describe('one approval, one token', () => {
  it('a claim cannot be replayed after it succeeded', async () => {
    const alice = await createUser();
    const start = await app.request('/api/devices/link/start', post({ deviceName: 'Mac' }));
    const { requestId } = (await start.json()) as { requestId: string };
    await app.request(`/api/devices/link/${requestId}/approve`, post({}, alice.token));
    expect(
      (await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' })).status,
    ).toBe(200);
    // The same id again must not mint a second device.
    expect(
      (await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' })).status,
    ).toBe(404);
  });

  it('a request cannot be approved twice by different people', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const start = await app.request('/api/devices/link/start', post({ deviceName: 'Mac' }));
    const { requestId } = (await start.json()) as { requestId: string };

    expect(
      (await app.request(`/api/devices/link/${requestId}/approve`, post({}, alice.token))).status,
    ).toBe(200);
    // Bob must not be able to steal a pending approval.
    expect(
      (await app.request(`/api/devices/link/${requestId}/approve`, post({}, bob.token))).status,
    ).toBe(404);
  });

  it('an unapproved request yields no token however many times it is polled', async () => {
    const start = await app.request('/api/devices/link/start', post({ deviceName: 'Mac' }));
    const { requestId } = (await start.json()) as { requestId: string };
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' });
      expect(await res.json()).toEqual({ status: 'pending' });
    }
  });
});

describe('hostile values from a machine we do not control', () => {
  it('refuses a portal id that could escape into a path', async () => {
    const alice = await createUser();
    const device = await linked(alice.token);
    for (const portalId of ['../../etc/passwd', 'a/b', 'UPPER', 'with space', '']) {
      const res = await app.request(
        '/api/devices/portal-snapshot',
        post(snapshot({ portalId }), device.token),
      );
      expect(res.status).toBe(400);
    }
  });

  it('refuses an origin that is not a url', async () => {
    const alice = await createUser();
    const device = await linked(alice.token);
    // z.url() checks syntax, not scheme: javascript: and data: are valid URLs.
    for (const origin of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'not a url',
      '',
      'ftp://x.test',
    ]) {
      const res = await app.request(
        '/api/devices/portal-snapshot',
        post(snapshot({ origin }), device.token),
      );
      expect(res.status).toBe(400);
    }
  });

  it('survives a portal id crafted to break SQL', async () => {
    const alice = await createUser();
    const device = await linked(alice.token);
    // Rejected by the pattern, and the table is still there afterwards.
    const res = await app.request(
      '/api/devices/portal-snapshot',
      post(snapshot({ portalId: "veracross'; drop table portal_snapshots; --" }), device.token),
    );
    expect(res.status).toBe(400);
    expect(await db.select().from(portalSnapshots)).toEqual([]);
  });

  it('refuses a capture date that is not a date', async () => {
    const alice = await createUser();
    const device = await linked(alice.token);
    const res = await app.request(
      '/api/devices/portal-snapshot',
      post(snapshot({ capturedAt: 'yesterday' }), device.token),
    );
    expect(res.status).toBe(400);
  });

  it('stores a snapshot against the pushing device only', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const aliceDevice = await linked(alice.token);
    await linked(bob.token);

    await app.request('/api/devices/portal-snapshot', post(snapshot(), aliceDevice.token));
    const bobRows = await db
      .select()
      .from(portalSnapshots)
      .where(and(eq(portalSnapshots.userId, bob.id), eq(portalSnapshots.portalId, 'veracross')));
    expect(bobRows).toEqual([]);
  });
});

describe('revocation ends everything that device could do', () => {
  it('stops syncing, and stops minting sessions', async () => {
    const alice = await createUser();
    const device = await linked(alice.token);
    await app.request(`/api/devices/${device.deviceId}/revoke`, post({}, alice.token));

    expect(
      (await app.request('/api/devices/portal-snapshot', post(snapshot(), device.token))).status,
    ).toBe(401);
    expect(
      (await app.request('/api/devices/session', { method: 'POST', headers: bearer(device.token) }))
        .status,
    ).toBe(401);
  });

  it('leaves already-captured data readable by the student who owns it', async () => {
    // Revoking a laptop should not destroy the coursework it already brought
    // back -- that is what Remove is for, and they are different decisions.
    const alice = await createUser();
    const device = await linked(alice.token);
    await app.request('/api/devices/portal-snapshot', post(snapshot(), device.token));
    await app.request(`/api/devices/${device.deviceId}/revoke`, post({}, alice.token));

    const sites = (await (
      await app.request('/api/devices/sites', { headers: bearer(alice.token) })
    ).json()) as unknown[];
    expect(sites).toHaveLength(1);
  });
});
