import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const minimalEnv = {
  NODE_ENV: 'test' as const,
  PORT: '3000',
  DATABASE_URL: 'postgres://localhost/test',
  API_BASE_URL: 'http://localhost:3000',
  WEB_BASE_URL: 'http://localhost:5173',
  AUTH_SECRET: 'x'.repeat(40),
  MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
};

describe('env validation', () => {
  it('requires VAULT_HOOK_SECRET when GMAIL_PUBSUB_TOPIC is set', () => {
    const env = {
      ...minimalEnv,
      GMAIL_PUBSUB_TOPIC: 'projects/my-project/topics/contexto-gmail',
    };

    expect(() => loadEnv(env as never)).toThrow(/VAULT_HOOK_SECRET/);
  });

  it('applies default for VAULT_LIVE_POLL_MINUTES when unset', () => {
    const env = loadEnv(minimalEnv as never);
    expect(env.VAULT_LIVE_POLL_MINUTES).toBe(5);
  });

  it('applies default for VAULT_REFRESH_BUDGET_MINUTES when unset', () => {
    const env = loadEnv(minimalEnv as never);
    expect(env.VAULT_REFRESH_BUDGET_MINUTES).toBe(50);
  });
});
