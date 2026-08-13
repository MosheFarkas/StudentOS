import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase, agents, session, user, type Database } from '@contexto/db';

/**
 * Integration-test harness.
 *
 * Runs against a real Postgres rather than a mock, because everything worth
 * testing here IS the database behaviour: foreign keys, unique constraints, and
 * queries scoped by user id. A mocked query builder would happily "pass" a test
 * for cross-user access that the real database would too.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://studentos:studentos@localhost:5432/contexto_test';

let db: Database | undefined;

export async function testDb(): Promise<Database> {
  if (!db) {
    db = createDatabase({ url: TEST_DATABASE_URL, maxConnections: 4 });
    await migrate(db, {
      migrationsFolder: new URL('../../../../packages/db/migrations', import.meta.url).pathname,
    });
  }
  return db;
}

/** Wipe between tests. Cascades handle everything hanging off a user. */
export async function reset(): Promise<void> {
  const database = await testDb();
  await database.execute(sql`TRUNCATE TABLE "user" CASCADE`);
}

export interface TestUser {
  id: string;
  email: string;
  /** Send as `Authorization: Bearer <token>` to authenticate as this user. */
  token: string;
}

/**
 * Create a user with a live session.
 *
 * The session row is inserted directly rather than driving a real sign-up,
 * because Google OAuth cannot be completed from a test. Better Auth reads the
 * bearer token straight off this table, so the middleware under test is the
 * real one -- only the sign-in that produced the row is skipped.
 */
export async function createUser(): Promise<TestUser> {
  const database = await testDb();
  const id = `u_${randomUUID()}`;
  const email = `${id}@example.test`;
  const token = randomUUID().replace(/-/g, '');
  const now = new Date();

  await database.insert(user).values({
    id,
    name: 'Test User',
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });

  await database.insert(session).values({
    id: randomUUID(),
    token,
    userId: id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  });

  return { id, email, token };
}

export async function createAgent(userId: string, name = 'Test Agent') {
  const database = await testDb();
  const [row] = await database
    .insert(agents)
    .values({ userId, name, purpose: 'Answer questions.' })
    .returning();
  if (!row) throw new Error('failed to create test agent');
  return row;
}
