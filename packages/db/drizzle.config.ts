import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs this file directly, so it gets no env loading from the app.
// Without this, `pnpm db:migrate` only works if you happen to have sourced .env
// into your shell first -- which works right up until it silently doesn't.
const envPath = new URL('../../.env', import.meta.url).pathname;
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run migrations. See .env.example.');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
});
