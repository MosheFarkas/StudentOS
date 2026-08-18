import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createAuth } from '../auth.js';
import { handleError } from '../errors.js';
import { createRoutes } from './index.js';
import type { AppContext } from '../context.js';
import { and, desc, eq } from 'drizzle-orm';
import { portalSnapshots } from '@contexto/db';
import { createUser, reset, testDb, TEST_DATABASE_URL } from '../test-support/harness.js';

/**
 * Device linking, and what a linked device may reach.
 *
 * A device token is a standing credential for a student's account held on a
 * laptop, so the two properties worth the most here are that one approval
 * mints exactly one token, and that a token belonging to one student can never
 * read or write another's portal data.
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
    env, db, auth: createAuth(db, env as never), telegram: undefined,
  } as unknown as AppContext;
  app = new Hono().route('/api', createRoutes(ctx)).onError(handleError);
});

beforeEach(reset);

const as = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const json = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

async function startLink(name = 'Test Laptop') {
  const res = await app.request('/api/devices/link/start', json({ deviceName: name }));
  return (await res.json()) as { requestId: string };
}

async function linkDevice(userToken: string, name = 'Test Laptop') {
  const { requestId } = await startLink(name);
  await app.request(`/api/devices/link/${requestId}/approve`, json({}, userToken));
  const res = await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' });
  return (await res.json()) as { status: string; token: string; deviceId: string };
}

describe('linking', () => {
  it('does not issue a token before the student approves', async () => {
    const { requestId } = await startLink();
    const res = await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' });
    expect(await res.json()).toEqual({ status: 'pending' });
  });

  it('issues a token after approval', async () => {
    const alice = await createUser();
    const result = await linkDevice(alice.token);
    expect(result.status).toBe('linked');
    expect(result.token).toEqual(expect.any(String));
  });

  it('issues exactly one token per approval', async () => {
    const alice = await createUser();
    const { requestId } = await startLink();
    await app.request(`/api/devices/link/${requestId}/approve`, json({}, alice.token));

    // Both claims race the same conditional UPDATE; only one row can match.
    const [first, second] = await Promise.all([
      app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' }),
      app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' }),
    ]);
    const results = (await Promise.all([first.json(), second.json()])) as { status: string }[];
    expect(results.filter((r) => r.status === 'linked')).toHaveLength(1);
  });

  it('refuses approval from an unauthenticated caller', async () => {
    const { requestId } = await startLink();
    const res = await app.request(`/api/devices/link/${requestId}/approve`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('refuses to claim an unknown request', async () => {
    const res = await app.request(
      '/api/devices/link/00000000-0000-4000-8000-000000000000/claim', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('device token', () => {
  it('rejects a made-up device token', async () => {
    const res = await app.request('/api/devices/portal-snapshot',
      json({ portalId: 'veracross', origin: 'https://portals.veracross.com',
             redacted: true, capturedAt: new Date().toISOString(), map: {} }, 'not-a-token'));
    expect(res.status).toBe(401);
  });

  it('is not accepted where a browser session is expected', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    // A device token must not act as a session -- it should not list agents.
    const res = await app.request('/api/agents', as(device.token));
    expect(res.status).toBe(401);
  });

  it('stops working once revoked', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    await app.request(`/api/devices/${device.deviceId}/revoke`, json({}, alice.token));
    const res = await app.request('/api/devices/portal-snapshot',
      json({ portalId: 'veracross', origin: 'https://portals.veracross.com',
             redacted: true, capturedAt: new Date().toISOString(), map: {} }, device.token));
    expect(res.status).toBe(401);
  });
});

describe('cross-user isolation', () => {
  it("does not let one student revoke another student's device", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkDevice(alice.token);

    await app.request(`/api/devices/${device.deviceId}/revoke`, json({}, bob.token));

    // Bob's revoke must not have taken effect.
    const res = await app.request('/api/devices/portal-snapshot',
      json({ portalId: 'veracross', origin: 'https://portals.veracross.com',
             redacted: true, capturedAt: new Date().toISOString(), map: {} }, device.token));
    expect(res.status).toBe(200);
  });

  it("does not list another student's devices", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await linkDevice(alice.token, 'Alice Laptop');

    const res = await app.request('/api/devices', as(bob.token));
    expect(await res.json()).toEqual([]);
  });

  it('stores a snapshot against the owning student only', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkDevice(alice.token);

    await app.request('/api/devices/portal-snapshot',
      json({ portalId: 'veracross', origin: 'https://portals.veracross.com',
             redacted: true, capturedAt: new Date().toISOString(),
             map: { pages: [{ url: 'x', title: 'Alice grades' }] } }, device.token));

    const res = await app.request('/api/devices', as(bob.token));
    expect(JSON.stringify(await res.json())).not.toContain('Alice');
  });
});

describe('snapshot retention', () => {
  const push = (token: string, portalId: string, day: number) =>
    app.request('/api/devices/portal-snapshot',
      json({ portalId, origin: 'https://portals.veracross.com', redacted: false,
             capturedAt: new Date(Date.UTC(2026, 8, day)).toISOString(),
             map: { day } }, token));

  const rowsFor = (userId: string, portalId: string) =>
    db.select({ map: portalSnapshots.map, capturedAt: portalSnapshots.capturedAt })
      .from(portalSnapshots)
      .where(and(eq(portalSnapshots.userId, userId), eq(portalSnapshots.portalId, portalId)))
      .orderBy(desc(portalSnapshots.capturedAt));

  it('keeps only the newest few, and the newest is among them', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    for (let day = 1; day <= 8; day += 1) await push(device.token, 'veracross', day);

    const rows = await rowsFor(alice.id, 'veracross');
    expect(rows).toHaveLength(5);
    // Newest kept, oldest gone -- the failure mode is pruning the wrong end.
    expect((rows[0]?.map as { day: number }).day).toBe(8);
    expect(rows.map((r) => (r.map as { day: number }).day)).toEqual([8, 7, 6, 5, 4]);
  });

  it('does not prune a different portal belonging to the same student', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    await push(device.token, 'mozaik', 1);
    for (let day = 1; day <= 8; day += 1) await push(device.token, 'veracross', day);

    expect(await rowsFor(alice.id, 'mozaik')).toHaveLength(1);
  });

  it("does not prune another student's snapshots", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const aliceDevice = await linkDevice(alice.token);
    const bobDevice = await linkDevice(bob.token);

    await push(bobDevice.token, 'veracross', 1);
    for (let day = 1; day <= 8; day += 1) await push(aliceDevice.token, 'veracross', day);

    expect(await rowsFor(bob.id, 'veracross')).toHaveLength(1);
  });
});

describe('snapshot size', () => {
  it('refuses a snapshot too large to store', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    // The device runs on a machine we do not control, so this bound has to
    // hold against a runaway crawl, not just an honest large portal.
    const huge = { pages: [{ url: 'x', title: 'x', blob: 'y'.repeat(9 * 1024 * 1024) }] };
    const res = await app.request('/api/devices/portal-snapshot',
      json({ portalId: 'veracross', origin: 'https://portals.veracross.com', redacted: false,
             capturedAt: new Date().toISOString(), map: huge }, device.token));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts a large but realistic portal', async () => {
    const alice = await createUser();
    const device = await linkDevice(alice.token);
    const realistic = { pages: Array.from({ length: 40 }, (_, i) => ({ url: `p${i}`, title: `Page ${i}`, components: [{ shape: { rows: Array.from({ length: 50 }, (_, r) => ({ id: r, title: 'Assignment' })) } }] })) };
    const res = await app.request('/api/devices/portal-snapshot',
      json({ portalId: 'veracross', origin: 'https://portals.veracross.com', redacted: false,
             capturedAt: new Date().toISOString(), map: realistic }, device.token));
    expect(res.status).toBe(200);
  });
});
