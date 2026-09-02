import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createAuth } from '../auth.js';
import { handleError } from '../errors.js';
import { createRoutes } from './index.js';
import type { AppContext } from '../context.js';
import {
  createUser,
  grantGoogle,
  reset,
  testDb,
  TEST_DATABASE_URL,
} from '../test-support/harness.js';

/**
 * What the build button and the page behind it are told.
 *
 * Two different fixes hide behind "not connected": consent that was never
 * given, which the student fixes on the consent screen, and consent Google has
 * stopped honouring, which they fix by signing in again. The page can only
 * say the right one if the API tells them apart.
 */

const CLASSROOM = 'https://www.googleapis.com/auth/classroom.courses.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';

let app: Hono;
let asked = 0;
let google: () => Promise<{ accessToken: string | null }>;

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
  const auth = createAuth(db, env as never);
  // Real sessions, real routes, real database. Only the token mint is
  // stubbed, because a real refresh would dial Google.
  const ctx = {
    env,
    db,
    auth: {
      ...auth,
      api: {
        ...auth.api,
        getAccessToken: async () => {
          asked += 1;
          return google();
        },
      },
    },
    telegram: undefined,
  } as unknown as AppContext;
  app = new Hono().route('/api', createRoutes(ctx)).onError(handleError);
});

beforeEach(async () => {
  await reset();
  asked = 0;
  google = async () => ({ accessToken: 'ya29.token' });
});

const as = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe('what the build button is told', () => {
  it('refuses a dead token and says to sign in again', async () => {
    const alice = await createUser();
    await grantGoogle(alice.id, [CLASSROOM, GMAIL, DRIVE]);
    google = async () => {
      throw new Error('invalid_grant');
    };

    const res = await app.request('/api/vault/build', { method: 'POST', ...as(alice.token) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      started: false,
      reason: 'not-connected',
      ready: false,
      expired: true,
      missing: [],
    });
  });

  it('refuses missing consent without asking Google', async () => {
    const alice = await createUser();
    await grantGoogle(alice.id, [CLASSROOM, GMAIL]);

    const res = await app.request('/api/vault/build', { method: 'POST', ...as(alice.token) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      started: false,
      ready: false,
      expired: false,
      missing: ['Drive'],
    });
    expect(asked).toBe(0);
  });

  it('tells the page when the connection has expired', async () => {
    const alice = await createUser();
    await grantGoogle(alice.id, [CLASSROOM, GMAIL, DRIVE]);
    google = async () => {
      throw new Error('invalid_grant');
    };

    const res = await app.request('/api/vault', as(alice.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ready: false, expired: true });
  });
});
