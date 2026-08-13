import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createAuth } from '../auth.js';
import { handleError } from '../errors.js';
import { createRoutes } from './index.js';
import type { AppContext } from '../context.js';
import {
  createAgent,
  createUser,
  reset,
  testDb,
  TEST_DATABASE_URL,
} from '../test-support/harness.js';

/**
 * Cross-user isolation.
 *
 * This is the test the product cannot ship without. Every route here is scoped
 * by user id, and a single missing `eq(agents.userId, ...)` would let any
 * student read any other student's agent, conversation history, and -- through
 * the agent -- their calendar.
 */

let app: Hono;

beforeAll(async () => {
  const db = await testDb();

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

  // Real auth, real routes, real database. Only the LLM is absent -- these
  // tests never reach a model call, and one would cost money and be flaky.
  const ctx = {
    env,
    db,
    auth: createAuth(db, env as never),
    telegram: undefined,
  } as unknown as AppContext;

  // Same error handler as the real server -- see src/errors.ts. Without it a
  // test harness sees 500s where production returns 404s.
  app = new Hono().route('/api', createRoutes(ctx)).onError(handleError);
});

beforeEach(reset);

const as = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe('authentication', () => {
  it('rejects requests with no token', async () => {
    const res = await app.request('/api/agents');
    expect(res.status).toBe(401);
  });

  it('rejects a made-up token', async () => {
    const res = await app.request('/api/agents', as('not-a-real-token'));
    expect(res.status).toBe(401);
  });

  it('accepts a valid session token', async () => {
    const alice = await createUser();
    const res = await app.request('/api/agents', as(alice.token));
    expect(res.status).toBe(200);
  });
});

describe('cross-user isolation', () => {
  it("does not list another student's agents", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await createAgent(alice.id, "Alice's agent");

    const res = await app.request('/api/agents', as(bob.token));
    const body = (await res.json()) as { agents: unknown[] };

    expect(body.agents).toHaveLength(0);
  });

  it("returns 404 -- not 403 -- when fetching another student's agent", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}`, as(bob.token));

    // 404 rather than 403 is deliberate: a 403 confirms the id exists, which
    // leaks that a given agent belongs to somebody.
    expect(res.status).toBe(404);
  });

  it("does not expose another student's conversation", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}/messages`, as(bob.token));
    expect(res.status).toBe(404);
  });

  it("cannot send a message to another student's agent", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    // Must fail on ownership BEFORE reaching the model -- otherwise Bob spends
    // Alice's quota and writes to her transcript.
    expect(res.status).toBe(404);
  });

  it("cannot delete another student's agent", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const agent = await createAgent(alice.id);

    expect(
      (await app.request(`/api/agents/${agent.id}`, { method: 'DELETE', ...as(bob.token) })).status,
    ).toBe(404);

    // And it is genuinely still there.
    const stillThere = await app.request(`/api/agents/${agent.id}`, as(alice.token));
    expect(stillThere.status).toBe(200);
  });
});

describe('agent creation', () => {
  it('creates an agent owned by the caller', async () => {
    const alice = await createUser();

    const res = await app.request('/api/agents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Study buddy', purpose: 'Track my assignments.' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { id: string; name: string } };
    expect(body.agent.name).toBe('Study buddy');

    const list = await app.request('/api/agents', as(alice.token));
    expect(((await list.json()) as { agents: unknown[] }).agents).toHaveLength(1);
  });

  it('rejects an empty name or purpose', async () => {
    const alice = await createUser();

    const res = await app.request('/api/agents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', purpose: '' }),
    });

    expect(res.status).toBe(400);
  });
});
