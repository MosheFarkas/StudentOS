import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export * as schema from './schema/index.js';
export * from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseConfig {
  url: string;
  /**
   * Pool size. Keep this low on the worker -- it runs a handful of scheduled
   * jobs, and a droplet-sized Postgres has a modest connection ceiling that the
   * API should get most of.
   */
  maxConnections?: number;
}

export function createDatabase({ url, maxConnections = 10 }: DatabaseConfig) {
  const client = postgres(url, { max: maxConnections });
  return drizzle(client, { schema });
}
