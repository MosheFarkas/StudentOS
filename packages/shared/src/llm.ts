import { z } from 'zod';

/**
 * Providers a student can bring their own key for.
 *
 * `platform` is deliberately NOT in this list -- it is the subsidised tier we
 * pay for, and a student never supplies a key for it. See packages/llm.
 */
export const byokProviderSchema = z.enum(['openai', 'anthropic']);
export type ByokProvider = z.infer<typeof byokProviderSchema>;

/** Every provider the resolver can return, including the platform tier. */
export const providerIdSchema = z.enum(['openai', 'anthropic', 'platform']);
export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * What the client is allowed to know about a stored credential.
 *
 * The plaintext key never leaves the server. `last4` exists only so the UI can
 * show "sk-...a1b2" and let a student tell two keys apart.
 */
export const credentialSummarySchema = z.object({
  id: z.string(),
  provider: byokProviderSchema,
  label: z.string(),
  last4: z.string().length(4),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type CredentialSummary = z.infer<typeof credentialSummarySchema>;

export const addCredentialSchema = z.object({
  provider: byokProviderSchema,
  label: z.string().min(1).max(64),
  apiKey: z.string().min(20),
});
export type AddCredentialInput = z.infer<typeof addCredentialSchema>;

/**
 * One usage bar on the settings screen.
 *
 * `resetsAt` is null for the session window, which trails the clock and so has
 * no single moment of reset -- it recovers gradually as old calls fall out of
 * the last five hours.
 */
export const quotaBarSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  resetsAt: z.iso.datetime().nullable(),
});
export type QuotaBar = z.infer<typeof quotaBarSchema>;

/** Where a student currently sits: their own key, or our subsidised tier. */
export const usageStatusSchema = z.object({
  activeProvider: providerIdSchema,
  /** Null when the student is on their own key -- we do not meter those. */
  quota: z
    .object({
      windowStart: z.iso.datetime(),
      windowEnd: z.iso.datetime(),
      tokensUsed: z.number().int().nonnegative(),
      tokenLimit: z.number().int().positive(),
    })
    .nullable(),
  /**
   * The two limits a student actually meets, when they are on our tier.
   *
   * The month above is what the allowance is defined as; these are how it is
   * spent -- a five-hour burst window and the week it belongs to.
   */
  limits: z
    .object({
      session: quotaBarSchema,
      week: quotaBarSchema,
    })
    .nullable(),
});
export type UsageStatus = z.infer<typeof usageStatusSchema>;
