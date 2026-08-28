import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Vault } from '@contexto/agent';
import { eq } from 'drizzle-orm';
import { agentMessages } from '@contexto/db';
import { createAuth } from '../auth.js';
import { handleError } from '../errors.js';
import { createRoutes } from './index.js';
import { beginTurn, endTurn, setActivity } from '../turns-in-flight.js';
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

/*
 * A second server, with vaults switched on.
 *
 * The first deliberately has VAULT_ROOT unset, which is the ordinary state of
 * a deployment that has not turned vaults on and is what one of the tests
 * below is about. Anything that needs a real vault on disk uses this one.
 */
let withVaults: Hono;
let vaultRoot: string;

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

  vaultRoot = mkdtempSync(join(tmpdir(), 'contexto-routes-vault-'));
  const vaultCtx = { ...ctx, env: { ...env, VAULT_ROOT: vaultRoot } } as unknown as AppContext;
  withVaults = new Hono().route('/api', createRoutes(vaultCtx)).onError(handleError);
});

afterAll(() => rmSync(vaultRoot, { recursive: true, force: true }));

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

/**
 * Removing an agent.
 *
 * The list screen offers this, and what it promises is that the conversation
 * goes too -- "delete X and everything it has said". That is a cascade in the
 * schema rather than anything the route does, so it is worth pinning here:
 * a delete that quietly left the messages behind would keep a student's
 * transcript after they asked for it to be gone.
 */
describe('deleting an agent', () => {
  it('removes it, and the conversation with it', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);
    const db = await testDb();

    await db.insert(agentMessages).values([
      { agentId: agent.id, role: 'user', content: 'something private' },
      { agentId: agent.id, role: 'assistant', content: 'a reply about it' },
    ]);

    expect(
      (await app.request(`/api/agents/${agent.id}`, { method: 'DELETE', ...as(alice.token) }))
        .status,
      // 204: nothing left to describe. `res.ok` covers it on the client.
    ).toBe(204);

    // Gone from the list, and gone when asked for directly.
    expect((await app.request(`/api/agents/${agent.id}`, as(alice.token))).status).toBe(404);

    const left = await db.select().from(agentMessages).where(eq(agentMessages.agentId, agent.id));
    expect(left).toEqual([]);
  });

  it("leaves the student's other agents alone", async () => {
    const alice = await createUser();
    const doomed = await createAgent(alice.id);
    const keeper = await createAgent(alice.id);

    await app.request(`/api/agents/${doomed.id}`, { method: 'DELETE', ...as(alice.token) });

    expect((await app.request(`/api/agents/${keeper.id}`, as(alice.token))).status).toBe(200);
  });
});

/**
 * Saying that a turn is still running.
 *
 * A turn outlives the request that started it, so a page loaded after a
 * refresh has no memory of having asked. Without this the student sees their
 * own question sitting unanswered and then an answer appearing minutes later
 * from nowhere, which reads as the app having lost track.
 */
describe('a turn still running', () => {
  it('says nothing is happening on a quiet conversation', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}/messages`, as(alice.token));
    expect(await res.json()).toMatchObject({ pending: false });
  });

  it('says a turn is running while one is', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    beginTurn(agent.id);
    try {
      const res = await app.request(`/api/agents/${agent.id}/messages`, as(alice.token));
      expect(await res.json()).toMatchObject({ pending: true });
    } finally {
      endTurn(agent.id);
    }
  });

  it('goes quiet again once the turn ends', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    beginTurn(agent.id);
    endTurn(agent.id);

    const res = await app.request(`/api/agents/${agent.id}/messages`, as(alice.token));
    expect(await res.json()).toMatchObject({ pending: false });
  });

  it("does not report another conversation's turn", async () => {
    const alice = await createUser();
    const busy = await createAgent(alice.id);
    const quiet = await createAgent(alice.id);

    beginTurn(busy.id);
    try {
      const res = await app.request(`/api/agents/${quiet.id}/messages`, as(alice.token));
      expect(await res.json()).toMatchObject({ pending: false });
    } finally {
      endTurn(busy.id);
    }
  });

  /*
   * What it is doing, not just that it is doing something. The poll already
   * carries whether a turn is running; carrying the step it is on is what
   * lets the conversation name the work rather than spin a bare word through
   * a minute of reading a student's mail.
   */
  it('says which tool the turn is on', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    beginTurn(agent.id);
    setActivity(agent.id, { kind: 'tool', name: 'gmail_search' });
    try {
      const res = await app.request(`/api/agents/${agent.id}/messages`, as(alice.token));
      expect(await res.json()).toMatchObject({
        pending: true,
        activity: { kind: 'tool', name: 'gmail_search' },
      });
    } finally {
      endTurn(agent.id);
    }
  });

  it('says nothing about the step on a quiet conversation', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}/messages`, as(alice.token));
    const body = (await res.json()) as { activity?: unknown };
    expect(body.activity ?? null).toBeNull();
  });

  it("does not report another conversation's step", async () => {
    const alice = await createUser();
    const busy = await createAgent(alice.id);
    const quiet = await createAgent(alice.id);

    beginTurn(busy.id);
    setActivity(busy.id, { kind: 'tool', name: 'gmail_search' });
    try {
      const res = await app.request(`/api/agents/${quiet.id}/messages`, as(alice.token));
      const body = (await res.json()) as { activity?: unknown };
      expect(body.activity ?? null).toBeNull();
    } finally {
      endTurn(busy.id);
    }
  });
});

/**
 * Reading and correcting what the agent thinks it knows.
 *
 * The profile is written by a background job from a student's own
 * conversations and then pinned in the system prompt, which means a wrong line
 * in it is quietly wrong in every future conversation. Being able to see it
 * and delete it is the difference between memory and surveillance.
 */
describe('the student profile', () => {
  it('comes back with the agent, empty until the job has written one', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}`, as(alice.token));
    const body = (await res.json()) as { agent: { profile: string } };

    expect(body.agent.profile).toBe('');
  });

  it('can be corrected by the student it describes', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}/profile`, {
      method: 'PATCH',
      headers: { ...as(alice.token).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'Takes chemistry. Revises by rewriting notes.' }),
    });
    const body = (await res.json()) as { agent: { profile: string } };

    expect(res.status).toBe(200);
    expect(body.agent.profile).toBe('Takes chemistry. Revises by rewriting notes.');
  });

  it('can be cleared entirely', async () => {
    // "Forget what you think you know about me" is the whole point of showing
    // it, so an empty string has to be a real answer rather than a validation
    // error.
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}/profile`, {
      method: 'PATCH',
      headers: { ...as(alice.token).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: '' }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: { profile: string } }).agent.profile).toBe('');
  });

  it('refuses more than the writer is allowed to keep', async () => {
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}/profile`, {
      method: 'PATCH',
      headers: { ...as(alice.token).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'x'.repeat(1401) }),
    });

    // Accepting it would mean silently trimming it on the next read, so the
    // student would see something they did not write.
    expect(res.status).toBe(400);
  });

  it("cannot be read or written through another student's agent", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}/profile`, {
      method: 'PATCH',
      headers: { ...as(bob.token).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'Bob was here.' }),
    });

    expect(res.status).toBe(404);
  });
});

/**
 * Looking at your own vault.
 *
 * The profile is a paragraph a person reads in fifteen seconds. The vault is
 * hundreds of notes about them, and until there is a way to see it they are
 * being asked to trust a filing cabinet nobody has opened.
 */
describe('browsing the vault', () => {
  it('returns nothing rather than failing when the deployment has no vaults', async () => {
    // VAULT_ROOT is unset in this harness, which is the ordinary state for a
    // deployment that has not turned vaults on.
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(`/api/agents/${agent.id}/vault`, as(alice.token));
    const body = (await res.json()) as { groups: unknown[]; episodes: number };

    expect(res.status).toBe(200);
    expect(body.groups).toEqual([]);
    expect(body.episodes).toBe(0);
  });

  it('shows a student their vault when they have no agents at all', async () => {
    /*
     * The vault belongs to the student and outlives the agents that read it.
     * Reaching it through an agent meant deleting your agents hid three and a
     * half thousand notes of your own school -- which is exactly what happened
     * to the account this was built against.
     */
    const alice = await createUser();
    await new Vault(vaultRoot, alice.id).write({
      name: 'class-chemistry',
      kind: 'document',
      source: 'agent',
      description: 'chemistry, as the vault has it',
      body: '# Chemistry',
    });

    const res = await withVaults.request('/api/vault/graph', as(alice.token));
    const body = (await res.json()) as { nodes: unknown[] };

    expect(res.status).toBe(200);
    expect(body.nodes).toHaveLength(1);
  });

  it('shows a student the notes even before any page describes them', async () => {
    // A vault mid-build has thousands of notes and no pages yet. Showing
    // nothing until the pages land would hide the work as it happens.
    const alice = await createUser();
    await new Vault(vaultRoot, alice.id).write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });

    const res = await withVaults.request('/api/vault/graph', as(alice.token));
    expect(((await res.json()) as { nodes: unknown[] }).nodes).toHaveLength(1);
  });

  it('draws the pages and the notes they were written from, as one graph', async () => {
    /*
     * A vault is one thing. The pages are what a person reads and the notes are
     * what they were written from, and the line between them is the most useful
     * edge in the picture -- it is what makes a page checkable.
     */
    const alice = await createUser();
    const vault = new Vault(vaultRoot, alice.id);
    await vault.write({
      name: 'chemistry-2025-2026',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry 2025-2026.',
    });
    await vault.write({
      name: 'user',
      kind: 'document',
      source: 'agent',
      description: 'Who this student is',
      body: 'They take [[class-chemistry]].',
    });
    await vault.write({
      name: 'class-chemistry',
      kind: 'document',
      source: 'agent',
      description: 'chemistry, as the vault has it',
      body: '# Chemistry\n\nWritten from [[chemistry-2025-2026]].',
    });

    const res = await withVaults.request('/api/vault/graph', as(alice.token));
    const body = (await res.json()) as {
      nodes: { name: string; kind: string }[];
      edges: { from: string; to: string }[];
    };

    expect(body.nodes.map((node) => node.name).sort()).toEqual([
      'chemistry-2025-2026',
      'class-chemistry',
      'user',
    ]);
    expect(body.edges).toContainEqual({ from: 'user', to: 'class-chemistry' });
    expect(body.edges).toContainEqual({ from: 'class-chemistry', to: 'chemistry-2025-2026' });
  });

  it('folds a club that will only ever have one room into its page', async () => {
    /*
     * Debating has no year in its name, so there will never be a second room
     * for it. Drawn as its own node it is a permanent duplicate sitting beside
     * the page describing it, and everything filed under it hangs off the copy.
     */
    const alice = await createUser();
    const vault = new Vault(vaultRoot, alice.id);
    await vault.write({
      name: 'debating',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Debating.',
    });
    await vault.write({
      name: 'motion-notes',
      kind: 'entity',
      source: 'classroom',
      description: 'Material',
      body: 'Motion notes.\nPart of [[debating]].',
    });
    await vault.write({
      name: 'class-debating',
      kind: 'document',
      source: 'agent',
      description: 'debating',
      body: '# Debating\n\nWritten from [[debating]].',
    });

    const res = await withVaults.request('/api/vault/graph', as(alice.token));
    const body = (await res.json()) as {
      nodes: { name: string }[];
      edges: { from: string; to: string }[];
    };

    expect(body.nodes.map((node) => node.name)).not.toContain('debating');
    // And what hung off the room now hangs off the page, rather than floating.
    expect(body.edges).toContainEqual({ from: 'motion-notes', to: 'class-debating' });
  });

  it('folds the student into the page about them', async () => {
    /*
     * Their own school address turns up in their own inbox like anybody else's,
     * so the vault holds a Person note about the person whose vault it is.
     */
    const alice = await createUser();
    const vault = new Vault(vaultRoot, alice.id);
    await vault.write({
      name: 'user',
      kind: 'document',
      source: 'agent',
      description: 'Who this student is',
      body: 'A page about them.',
    });
    await vault.write({
      name: 'alice-themselves',
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: alice.email,
      body: 'Writes mail.',
    });
    await vault.write({
      name: 'an-essay',
      kind: 'entity',
      source: 'drive',
      description: 'File',
      body: 'An essay.\nShared by [[alice-themselves]].',
    });

    const res = await withVaults.request('/api/vault/graph', as(alice.token));
    const body = (await res.json()) as {
      nodes: { name: string }[];
      edges: { from: string; to: string }[];
    };

    expect(body.nodes.map((node) => node.name)).not.toContain('alice-themselves');
    expect(body.edges).toContainEqual({ from: 'an-essay', to: 'user' });
  });

  it('leaves everybody else a person', async () => {
    const alice = await createUser();
    const vault = new Vault(vaultRoot, alice.id);
    await vault.write({
      name: 'user',
      kind: 'document',
      source: 'agent',
      description: 'Who this student is',
      body: 'A page about them.',
    });
    await vault.write({
      name: 'mme-rivard',
      kind: 'entity',
      source: 'gmail',
      description: 'Person',
      externalId: 'rivard@school.example',
      body: 'Teaches French.',
    });

    const res = await withVaults.request('/api/vault/graph', as(alice.token));
    expect(
      ((await res.json()) as { nodes: { name: string }[] }).nodes.map((n) => n.name),
    ).toContain('mme-rivard');
  });

  it('sends what a drawing needs and not what it does not', async () => {
    // No bodies: a picture of four thousand notes should not cost four thousand
    // note bodies over the wire. What a thing says is fetched when clicked.
    const alice = await createUser();
    await new Vault(vaultRoot, alice.id).write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry, and a great deal more prose that nobody is drawing.',
    });

    const res = await withVaults.request('/api/vault/graph', as(alice.token));
    expect(JSON.stringify(await res.json())).not.toContain('great deal more prose');
  });

  it("will not hand one student another student's graph", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await new Vault(vaultRoot, bob.id).write({
      name: 'class-chemistry',
      kind: 'document',
      source: 'agent',
      description: 'chemistry, as the vault has it',
      body: '# Chemistry',
    });

    const res = await withVaults.request('/api/vault/graph', as(alice.token));
    expect(((await res.json()) as { nodes: unknown[] }).nodes).toHaveLength(0);
  });

  it("will not hand one student another student's page", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await new Vault(vaultRoot, bob.id).write({
      name: 'class-chemistry',
      kind: 'document',
      source: 'agent',
      description: 'chemistry, as the vault has it',
      body: '# Chemistry',
    });

    const res = await withVaults.request('/api/vault/doc/class-chemistry', as(alice.token));
    expect(res.status).toBe(404);
  });

  it('opens one page by name', async () => {
    const alice = await createUser();
    await new Vault(vaultRoot, alice.id).write({
      name: 'class-chemistry',
      kind: 'document',
      source: 'agent',
      description: 'chemistry, as the vault has it',
      body: '# Chemistry\n\nTaught by [[mr-ali]].',
    });

    const res = await withVaults.request('/api/vault/doc/class-chemistry', as(alice.token));
    const body = (await res.json()) as { document: { body: string } };

    expect(res.status).toBe(200);
    expect(body.document.body).toContain('Taught by');
  });

  it('reads one note, and what points at it, without an agent', async () => {
    const alice = await createUser();
    const vault = new Vault(vaultRoot, alice.id);
    await vault.write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });
    await vault.write({
      name: '2026-09-02-moved',
      kind: 'episode',
      source: 'gmail',
      description: 'A deadline moved.',
      occurred: '2026-09-02T10:00:00Z',
      body: 'In [[chemistry]].',
    });

    const res = await withVaults.request('/api/vault/note/chemistry', as(alice.token));
    const body = (await res.json()) as { note: { name: string }; timeline: unknown[] };

    expect(body.note.name).toBe('chemistry');
    expect(body.timeline).toHaveLength(1);
  });

  it("is the same vault whichever of a student's agents asks for it", async () => {
    /*
     * The vault is built from the student's own Classroom and mail. It is
     * theirs, not any one agent's -- so keying it by agent gave a student who
     * made a second agent a second, empty vault, and that agent knew nothing
     * about their school at all. Found on a real account: two agents, 1401
     * notes under one of them and the settings page showing the other.
     */
    const alice = await createUser();
    const first = await createAgent(alice.id);
    const second = await createAgent(alice.id);

    await new Vault(vaultRoot, alice.id).write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });

    for (const agent of [first, second]) {
      const res = await withVaults.request(`/api/agents/${agent.id}/vault`, as(alice.token));
      const body = (await res.json()) as { groups: { kind: string; notes: unknown[] }[] };
      expect(body.groups[0]?.notes).toHaveLength(1);
    }
  });

  it("does not hand a student the vault of another student's agent", async () => {
    // The route is scoped by owner, and the vault is now keyed by owner too --
    // so this checks the second lookup did not quietly widen the first.
    const alice = await createUser();
    const bob = await createUser();
    const agent = await createAgent(bob.id);

    await new Vault(vaultRoot, bob.id).write({
      name: 'chemistry',
      kind: 'entity',
      source: 'classroom',
      description: 'Course',
      body: 'Chemistry.',
    });

    expect(
      (await withVaults.request(`/api/agents/${agent.id}/vault`, as(alice.token))).status,
    ).toBe(404);
  });

  it("will not show one student another's vault", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const agent = await createAgent(alice.id);

    // 404 rather than 403: a 403 confirms the agent exists.
    expect((await app.request(`/api/agents/${agent.id}/vault`, as(bob.token))).status).toBe(404);
    expect(
      (await app.request(`/api/agents/${agent.id}/vault/chemistry`, as(bob.token))).status,
    ).toBe(404);
  });

  it('refuses a note name that is not a note name', async () => {
    /*
     * The name goes into a path. Vault rejects anything outside the slug
     * alphabet, so this is the second of the two checks -- and the one that
     * proves a URL cannot reach past the vault directory.
     */
    const alice = await createUser();
    const agent = await createAgent(alice.id);

    const res = await app.request(
      `/api/agents/${agent.id}/vault/${encodeURIComponent('../../etc/passwd')}`,
      as(alice.token),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
