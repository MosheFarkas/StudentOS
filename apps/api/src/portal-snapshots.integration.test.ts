import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { readSchoolPortal, refreshSchoolPortal, type ToolContext } from '@contexto/agent';
import { createAuth } from './auth.js';
import { handleError } from './errors.js';
import { createRoutes } from './routes/index.js';
import { DbPortalSnapshots } from './portal-snapshots.js';
import type { AppContext } from './context.js';
import { resetRateLimits } from './middleware/rate-limit.js';
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
  const ctx = {
    env,
    db,
    auth: createAuth(db, env as never),
    telegram: undefined,
  } as unknown as AppContext;
  app = new Hono().route('/api', createRoutes(ctx)).onError(handleError);
});

beforeEach(async () => {
  resetRateLimits();
  await reset();
});

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
  return app.request(
    '/api/devices/portal-snapshot',
    post(
      {
        portalId: 'veracross',
        origin: realMap.origin,
        redacted: realMap.redacted,
        capturedAt: realMap.exploredAt,
        map: realMap,
      },
      deviceToken,
    ),
  );
}

describe('a real crawl, end to end', () => {
  it('arrives in a form the agent can actually read', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    expect((await pushRealMap(device.token)).status).toBe(200);

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
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
    await app.request(
      '/api/devices/portal-snapshot',
      post(
        {
          portalId: 'veracross',
          origin: realMap.origin,
          redacted: false,
          capturedAt: new Date(Date.now() + 60_000).toISOString(),
          map: {
            ...realMap,
            pages: [
              {
                url: 'u',
                title: 'Newer',
                components: [
                  {
                    url: 'c',
                    status: 200,
                    method: 'GET',
                    empty: false,
                    shape: { marker: 'SECOND-SYNC' },
                  },
                ],
              },
            ],
          },
        },
        device.token,
      ),
    );

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    const result = (await readSchoolPortal.execute({}, ctx)) as { portals: { pages: unknown[] }[] };
    expect(JSON.stringify(result.portals[0]?.pages)).toContain('SECOND-SYNC');
    expect(JSON.stringify(result.portals[0]?.pages)).not.toContain('Einstein');
  });

  it("never returns one student's portal to another", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);

    const bobCtx = {
      userId: bob.id,
      agentId: 'a2',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    const result = (await readSchoolPortal.execute({}, bobCtx)) as { unavailable?: boolean };
    expect(result.unavailable).toBe(true);
  });
});

describe('switching a site off', () => {
  const off = (portalId: string, enabled: boolean, token: string) =>
    app.request(`/api/devices/sites/${portalId}/enabled`, post({ enabled }, token));

  it('hides it from the agent, and back again', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);
    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;

    // Off is not "hidden in settings" -- the agent must not see it at all.
    await off('veracross', false, alice.token);
    expect(
      ((await readSchoolPortal.execute({}, ctx)) as { unavailable?: boolean }).unavailable,
    ).toBe(true);

    await off('veracross', true, alice.token);
    const back = (await readSchoolPortal.execute({}, ctx)) as { portals?: unknown[] };
    expect(back.portals).toHaveLength(1);
  });

  it('keeps the captured pages, so turning it back on costs no re-login', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);
    await off('veracross', false, alice.token);

    const listed = (await (
      await app.request('/api/devices/sites', {
        headers: { Authorization: `Bearer ${alice.token}` },
      })
    ).json()) as { portalId: string; enabled: boolean }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.enabled).toBe(false);
  });

  it("does not let one student switch off another's site", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);

    await off('veracross', false, bob.token);

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    expect(
      ((await readSchoolPortal.execute({}, ctx)) as { portals?: unknown[] }).portals,
    ).toHaveLength(1);
  });
});

describe('removing a site', () => {
  it('deletes the captured pages', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);

    await app.request('/api/devices/sites/veracross', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.token}` },
    });

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    expect(
      ((await readSchoolPortal.execute({}, ctx)) as { unavailable?: boolean }).unavailable,
    ).toBe(true);
  });

  it("does not delete another student's site", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const device = await linkedDevice(alice.token);
    await pushRealMap(device.token);

    await app.request('/api/devices/sites/veracross', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bob.token}` },
    });

    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    expect(
      ((await readSchoolPortal.execute({}, ctx)) as { portals?: unknown[] }).portals,
    ).toHaveLength(1);
  });
});

describe('the agent asking a computer to look again', () => {
  it('queues work the device can then collect', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;

    const queued = (await refreshSchoolPortal.execute({ portalId: 'veracross' }, ctx)) as {
      queued: boolean;
      alreadyPending: boolean;
    };
    expect(queued.queued).toBe(true);
    expect(queued.alreadyPending).toBe(false);

    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { id: string; portalId: string }[];
    expect(work.map((w) => w.portalId)).toEqual(['veracross']);
  });

  it('does not queue the same site twice', async () => {
    // An agent asking twice in one conversation must not make a laptop open
    // two browsers.
    const alice = await createUser();
    await linkedDevice(alice.token);
    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;

    await refreshSchoolPortal.execute({ portalId: 'veracross' }, ctx);
    const second = (await refreshSchoolPortal.execute({ portalId: 'veracross' }, ctx)) as {
      alreadyPending: boolean;
    };
    expect(second.alreadyPending).toBe(true);
  });

  it("never hands one student's work to another's device", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const bobDevice = await linkedDevice(bob.token);
    const aliceCtx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;

    await refreshSchoolPortal.execute({ portalId: 'veracross' }, aliceCtx);

    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${bobDevice.token}` },
      })
    ).json()) as unknown[];
    expect(work).toEqual([]);
  });

  it('drops off the list once the device reports back', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    await refreshSchoolPortal.execute({ portalId: 'veracross' }, ctx);

    const [item] = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { id: string }[];

    await app.request(
      `/api/devices/pending/${item!.id}/complete`,
      post({ outcome: 'synced' }, device.token),
    );

    const after = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as unknown[];
    expect(after).toEqual([]);
  });

  it('tells the agent plainly when no computer is linked', async () => {
    const alice = await createUser();
    const ctx = {
      userId: alice.id,
      agentId: 'a1',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;
    // Queuing still succeeds -- there is simply nothing to collect it.
    const result = (await refreshSchoolPortal.execute({ portalId: 'veracross' }, ctx)) as {
      queued: boolean;
    };
    expect(result.queued).toBe(true);
  });
});

describe('which conversation the work belongs to', () => {
  it('remembers the agent that asked, so its browser shows there', async () => {
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    const ctx = {
      userId: alice.id,
      agentId: '11111111-1111-4111-8111-111111111111',
      portals: new DbPortalSnapshots(db),
    } as unknown as ToolContext;

    await refreshSchoolPortal.execute({ portalId: 'veracross' }, ctx);
    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { agentId: string | null }[];

    expect(work[0]?.agentId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('leaves it empty for work nobody asked for', async () => {
    // A scheduled sync has no conversation to belong to, and showing its
    // browser in one would be something appearing rather than something the
    // student started.
    const alice = await createUser();
    const device = await linkedDevice(alice.token);
    await new DbPortalSnapshots(db).requestRefresh(alice.id, 'veracross');

    const work = (await (
      await app.request('/api/devices/pending', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { agentId: string | null }[];
    expect(work[0]?.agentId).toBeNull();
  });
});
