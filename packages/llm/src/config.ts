/**
 * Model + pricing configuration for the platform (subsidised) tier.
 *
 * This is the file to edit when you change what we pay for. Nothing else in
 * the codebase should name a model string.
 */

/**
 * The model the platform tier runs on.
 *
 * GPT-5.6 Luna: $0.20 / $1.20 per million tokens, 1.05M context, 128K output.
 * Chosen over the cheaper GPT-5 mini ($0.125/$1.00) because Luna is the
 * current generation -- starting a new product on a two-generation-old model
 * schedules a migration for no benefit -- and because the 1.05M window gives
 * accumulated agent memory room before summarisation has to get aggressive.
 *
 * TODO(verify): this id is inferred from the docs URL slug
 * (developers.openai.com/api/docs/models/gpt-5.6-luna). Confirm it on the first
 * real call -- a wrong model id is a 404 at request time, not a startup error.
 */
export const PLATFORM_MODEL = 'gpt-5.6-luna';

/**
 * Prices in micro-USD per token, so usage rows can be summed as integers
 * without float drift. $0.20 per million tokens = 0.2 micro-USD per token.
 */
export const PLATFORM_PRICING = {
  inputMicroUsdPerToken: 0.2,
  outputMicroUsdPerToken: 1.2,
  /** Cached prefix reads are ~90% off. This is the main lever on our cost. */
  cachedInputMicroUsdPerToken: 0.02,
} as const;

/**
 * Default allowance for a student on the platform tier.
 *
 * Rough sizing: ~3k input + 500 output per agent turn, so 2M tokens is on the
 * order of 500 turns a month -- generous for a normal student, and a ceiling
 * that costs us well under a dollar if someone leans on it.
 *
 * Students on their own API key are not metered against this at all.
 */
export const DEFAULT_MONTHLY_TOKEN_QUOTA = 2_000_000;

/**
 * Upgrade path, for when a school is paying:
 *   GPT-5.6 Terra  $2.00 / $12.00  -- balanced production tier
 *   GPT-5.6 Sol    $5.00 / $30.00  -- frontier tier
 * Adding one is a second entry in the provider registry, not a refactor.
 */
