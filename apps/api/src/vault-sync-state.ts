import { eq } from 'drizzle-orm';
import { vaultSync, type Database } from '@contexto/db';

export type SyncState = typeof vaultSync.$inferSelect;
export type SyncPatch = Partial<Omit<SyncState, 'userId'>>;

export async function syncStateOf(db: Database, userId: string): Promise<SyncState | null> {
  const [row] = await db.select().from(vaultSync).where(eq(vaultSync.userId, userId)).limit(1);
  return row ?? null;
}

export async function syncStateByChannel(
  db: Database,
  channelId: string,
): Promise<SyncState | null> {
  const [row] = await db
    .select()
    .from(vaultSync)
    .where(eq(vaultSync.driveChannelId, channelId))
    .limit(1);
  return row ?? null;
}

export async function allSyncStates(db: Database): Promise<SyncState[]> {
  return db.select().from(vaultSync);
}

/** Write some fields, creating the row the first time. */
export async function updateSyncState(
  db: Database,
  userId: string,
  patch: SyncPatch,
): Promise<void> {
  await db
    .insert(vaultSync)
    .values({ userId, ...patch })
    .onConflictDoUpdate({ target: vaultSync.userId, set: patch });
}
