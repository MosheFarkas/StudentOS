import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { createUser, reset, testDb } from '../test-support/harness.js';
import { updateSyncState } from '../vault-sync-state.js';
import { createHookRoutes } from './hooks.js';

/**
 * Google rings the bell here.
 *
 * A forged ring can at most cause one extra sync of a student's own data
 * with their own token, so the checks are cheap and the answers are quick:
 * Pub/Sub retries anything that is not a 2xx.
 */

const SECRET = 's'.repeat(32);

async function appWith(bells: { ring: Mock }) {
  const ctx = {
    db: await testDb(),
    env: { VAULT_HOOK_SECRET: SECRET },
  } as unknown as AppContext;
  return new Hono().route('/api/hooks', createHookRoutes(ctx, bells));
}

const pubsub = (emailAddress: string) =>
  JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress, historyId: 1 })).toString('base64'),
      messageId: '1',
    },
    subscription: 'projects/p/subscriptions/s',
  });

describe('POST /api/hooks/gmail', () => {
  beforeEach(reset);

  it('refuses a wrong secret', async () => {
    const bells = { ring: vi.fn() };
    const app = await appWith(bells);
    const res = await app.request('/api/hooks/gmail?token=wrong', {
      method: 'POST',
      body: pubsub('a@b.c'),
    });
    expect(res.status).toBe(401);
    expect(bells.ring).not.toHaveBeenCalled();
  });

  it('rings the bell for a known mailbox and stays quiet for an unknown one', async () => {
    const bells = { ring: vi.fn() };
    const app = await appWith(bells);
    const { id, email } = await createUser();

    const known = await app.request(`/api/hooks/gmail?token=${SECRET}`, {
      method: 'POST',
      body: pubsub(email.toUpperCase()),
    });
    expect(known.status).toBe(204);
    expect(bells.ring).toHaveBeenCalledWith(id, 'gmail');

    const unknown = await app.request(`/api/hooks/gmail?token=${SECRET}`, {
      method: 'POST',
      body: pubsub('nobody@nowhere.example'),
    });
    expect(unknown.status).toBe(204);
    expect(bells.ring).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/hooks/drive', () => {
  beforeEach(reset);

  it('rings for a channel it knows, acknowledges sync, refuses the rest', async () => {
    const bells = { ring: vi.fn() };
    const app = await appWith(bells);
    const { id } = await createUser();
    await updateSyncState(await testDb(), id, {
      driveChannelId: 'ch1',
      driveChannelSecret: 'secret1',
    });

    const headers = (state: string, token = 'secret1', channel = 'ch1') => ({
      'x-goog-channel-id': channel,
      'x-goog-channel-token': token,
      'x-goog-resource-state': state,
      'x-goog-resource-id': 'r1',
    });

    expect(
      (await app.request('/api/hooks/drive', { method: 'POST', headers: headers('sync') })).status,
    ).toBe(200);
    expect(bells.ring).not.toHaveBeenCalled();

    expect(
      (await app.request('/api/hooks/drive', { method: 'POST', headers: headers('change') }))
        .status,
    ).toBe(200);
    expect(bells.ring).toHaveBeenCalledWith(id, 'drive');

    expect(
      (
        await app.request('/api/hooks/drive', {
          method: 'POST',
          headers: headers('change', 'nope'),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request('/api/hooks/drive', {
          method: 'POST',
          headers: headers('change', 'secret1', 'other'),
        })
      ).status,
    ).toBe(401);
    expect(bells.ring).toHaveBeenCalledTimes(1);
  });
});
