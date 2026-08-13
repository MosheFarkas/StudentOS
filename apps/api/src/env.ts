import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Load the repo-root .env into process.env, if it exists.
 *
 * Walks up from this file rather than relying on cwd, because cwd differs
 * between `pnpm dev` from the repo root and running the app from apps/api --
 * and a loader that silently finds nothing is worse than no loader at all.
 *
 * Node's loadEnvFile does not overwrite variables already in the environment,
 * which is the behaviour we want: a real environment variable on the droplet
 * beats a stale .env someone left lying around.
 */
function loadDotEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return; // hit the filesystem root
    dir = parent;
  }
}

/**
 * Treat `KEY=` in a .env file as "not set".
 *
 * Zod's .optional() only admits `undefined`, but a commented-out-by-emptying
 * variable arrives as an empty string. Without this, `PLATFORM_MONTHLY_TOKEN_QUOTA=`
 * coerces to 0 and fails the positive check, and an empty API key would be
 * "present" but useless. An empty value in a .env file always means absent.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

/**
 * Environment validation.
 *
 * Everything is validated at boot so a missing secret is a startup crash with a
 * useful message, not a 500 three days later when someone first tries to add an
 * API key. See .env.example.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),

  /** Public origin of this API. Must match the Google redirect URI's origin. */
  API_BASE_URL: z.url(),
  /** Where the SPA is served. Used for CORS and post-login redirects. */
  WEB_BASE_URL: z.url(),

  /** Better Auth signing secret. openssl rand -base64 32 */
  AUTH_SECRET: z.string().min(32),

  /**
   * Master key for encrypting students' API keys. 32 bytes, base64.
   *   openssl rand -base64 32
   *
   * Losing this makes every stored credential permanently unreadable -- there
   * is no recovery path, students would have to re-enter their keys. Back it up
   * somewhere other than the droplet it runs on.
   */
  MASTER_ENCRYPTION_KEY: z.string().min(1),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  /**
   * Our OpenAI key, funding the free tier. Optional: leave it unset and every
   * student must bring their own key, which is a legitimate way to run this
   * before you want an inference bill.
   */
  PLATFORM_OPENAI_API_KEY: optional(z.string().min(1)),
  /** Per-student monthly token allowance on the platform tier. */
  PLATFORM_MONTHLY_TOKEN_QUOTA: optional(z.coerce.number().int().positive()),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  // Only touch the filesystem when reading the real environment -- tests pass
  // an explicit source and should not pick up whatever is in the developer's
  // .env file.
  if (!source) {
    loadDotEnv();
    source = process.env;
  }

  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }

  return parsed.data;
}
