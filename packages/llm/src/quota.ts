import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '@contexto/db';
import { llmUsage } from '@contexto/db';
import type { ProviderId } from '@contexto/shared';
import { ContextoError } from '@contexto/shared';
import { DEFAULT_MONTHLY_TOKEN_QUOTA, PLATFORM_PRICING } from './config.js';
import type { TokenUsage } from './types.js';

/**
 * Metering and per-student limits for the platform tier.
 *
 * Only platform-tier calls are gated. A student on their own key is billed by
 * the provider directly, so capping them would be us restricting something we
 * are not paying for.
 */
export class QuotaService {
  constructor(
    private readonly db: Database,
    private readonly monthlyTokenQuota: number = DEFAULT_MONTHLY_TOKEN_QUOTA,
  ) {}

  /**
   * Throws `quota_exceeded` if the student is over their allowance.
   *
   * Called before the request, so the check races a concurrent one -- two
   * simultaneous calls can both pass at the boundary. That is deliberate:
   * serialising every inference call behind a lock costs more than the handful
   * of tokens it would save.
   */
  async assertWithinQuota(userId: string): Promise<void> {
    const used = await this.tokensUsedThisWindow(userId);
    if (used >= this.monthlyTokenQuota) {
      throw new ContextoError(
        'quota_exceeded',
        'You have used your monthly allowance. Add your own API key for unlimited use, ' +
          'or wait for the allowance to reset.',
      );
    }
  }

  async tokensUsedThisWindow(userId: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens}), 0)`,
      })
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.userId, userId),
          eq(llmUsage.provider, 'platform'),
          gte(llmUsage.createdAt, currentWindowStart()),
        ),
      );

    return Number(row?.total ?? 0);
  }

  /** Record a completed call. BYOK rows are stored but never gate anything. */
  async record(input: {
    userId: string;
    agentId?: string;
    provider: ProviderId;
    model: string;
    usage: TokenUsage;
  }): Promise<void> {
    await this.db.insert(llmUsage).values({
      userId: input.userId,
      agentId: input.agentId ?? null,
      provider: input.provider,
      model: input.model,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      costMicroUsd: input.provider === 'platform' ? platformCostMicroUsd(input.usage) : 0,
    });
  }

  get limit(): number {
    return this.monthlyTokenQuota;
  }
}

/** Calendar-month windows. Simple to explain to a student, simple to query. */
export function currentWindowStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function currentWindowEnd(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * What a call actually cost us, in integer micro-USD.
 *
 * Uncached and cached input are priced separately because the gap between them
 * is roughly 10x -- it is the difference between the platform tier being
 * affordable and not.
 */
export function platformCostMicroUsd(usage: TokenUsage): number {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return Math.round(
    uncachedInput * PLATFORM_PRICING.inputMicroUsdPerToken +
      usage.cachedInputTokens * PLATFORM_PRICING.cachedInputMicroUsdPerToken +
      usage.outputTokens * PLATFORM_PRICING.outputMicroUsdPerToken,
  );
}
