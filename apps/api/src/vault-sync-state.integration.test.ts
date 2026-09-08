import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, reset, testDb } from './test-support/harness.js';
import {
  allSyncStates,
  syncStateByChannel,
  syncStateOf,
  updateSyncState,
} from './vault-sync-state.js';

describe('the live sync bookmark', () => {
  beforeEach(reset);

  it('starts absent, upserts, and is found by its Drive channel', async () => {
    const db = await testDb();
    const { id } = await createUser();
    expect(await syncStateOf(db, id)).toBeNull();

    await updateSyncState(db, id, { drivePageToken: '900' });
    await updateSyncState(db, id, { driveChannelId: 'ch1', driveChannelSecret: 's' });

    const state = await syncStateOf(db, id);
    expect(state?.drivePageToken).toBe('900');
    expect(state?.driveChannelId).toBe('ch1');
    expect((await syncStateByChannel(db, 'ch1'))?.userId).toBe(id);
    expect(await syncStateByChannel(db, 'nope')).toBeNull();
    expect((await allSyncStates(db)).map((s) => s.userId)).toEqual([id]);
  });
});
