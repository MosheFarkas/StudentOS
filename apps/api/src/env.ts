import { z } from 'zod';

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
  PLATFORM_OPENAI_API_KEY: z.string().optional(),
  /** Per-student monthly token allowance on the platform tier. */
  PLATFORM_MONTHLY_TOKEN_QUOTA: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }

  return parsed.data;
}
