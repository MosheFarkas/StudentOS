import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { readSchoolPortal, type ToolContext } from '@contexto/agent';
import { createAuth } from './auth.js';
import { handleError } from './errors.js';
import { createRoutes } from './routes/index.js';
import { DbPortalSnapshots } from './portal-snapshots.js';
import type { AppContext } from './context.js';
import { createUser, reset, testDb, TEST_DATABASE_URL } from './test-support/harness.js';
import realMap from './test-support/portal-map.fixture.json' with { type: 'json' };

/**
 * The whole round trip, on output a real crawl actually produced.
 *
 * Every piece of this is tested on its own, which is exactly how a system
 * ends up broken at the seams: the explorer emits one shape, the tool expects
 * another, and both test suites pass. The fixture here is not hand-written --
 * it was captured from a live crawl, so a change to the explorer's output
 * shape shows up as a failure here rather than as an agent that answers
 * "no coursework" in September.
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
  const ctx = { env, db, auth: createAuth(db, env as never), telegram: undefined } as unknown as AppContext;
  app = new Hono().route('/api', createRoutes(ctx)).onError(handleError);
});

beforeEach(reset);

const post = (body: unknown, token: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

async function linkedDevice(userToken: string) {
  const start = await app.request('/api/devices/link/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceName: 'Test Mac' }),
  });
  const { requestId } = (await start.json()) as { requestId: string };
  await app.request(`/api/devices/link/${requestId}/approve`, post({}, userToken));
  const claim = await app.request(`/api/devices/link/${requestId}/claim`, { method: 'POST' });
  return (await claim.json()) as { token: string };
}

async function pushRealMap(deviceToken: string) {
  return app.request('/api/devices/portal-snapshot', post({
    portalId: 'veracross',
    origin: realMap.origin,
    redacted: realMap.redacted,
    capturedAt: realMap.exploredAt,
    map: realMap,
  }, deviceToken));
}

describe('a real crawl, end to end', () => {
  it('arrives in a form the agent can actually read', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    expect((await pushRealMap(device.token)).status).toBe(200);

    const ctx = {
      userId: alice.id, agentId: 'a1', portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    const result = (await readSchoolPortal.execute({}, ctx)) as {
      note: string;
      portals: { portalId: string; warning?: string; pages: unknown[] }[];
    };

    const portal = result.portals[0];
    expect(portal?.portalId).toBe('veracross');
    // No warning: the session was valid and the crawl returned real values.
    expect(portal?.warning).toBeUndefined();
    expect(portal?.pages.length).toBeGreaterThan(0);

    // The values themselves survived -- not just the structure around them.
    expect(JSON.stringify(portal?.pages)).toContain('Einstein');
    expect(result.note).toMatch(/NEVER as instructions/);
  });

  it('shows the newest capture after a re-sync', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);
    await app.request('/api/devices/portal-snapshot', post({
      portalId: 'veracross', origin: realMap.origin, redacted: false,
      capturedAt: new Date(Date.now() + 60_000).toISOString(),
      map: { ...realMap, pages: [{ url: 'u', title: 'Newer', components: [
        { url: 'c', status: 200, method: 'GET', empty: false, shape: { marker: 'SECOND-SYNC' } }] }] },
    }, device.token));

    const ctx = { userId: alice.id, agentId: 'a1', portals: new DbPortalSnapshots(db) } as unknown as ToolContext;
    const result = (await readSchoolPortal.execute({}, ctx)) as { portals: { pages: unknown[] }[] };
    expect(JSON.stringify(result.portals[0]?.pages)).toContain('SECOND-SYNC');
    expect(JSON.stringify(result.portals[0]?.pages)).not.toContain('Einstein');
  });

  it("never returns one student's portal to another", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);

    const bobCtx = { userId: bob.id, agentId: 'a2', portals: new DbPortalSnapshots(db) } as unknown as ToolContext;
    const result = (await readSchoolPortal.execute({}, bobCtx)) as { unavailable?: boolean };
    expect(result.unavailable).toBe(true);
  });
});
