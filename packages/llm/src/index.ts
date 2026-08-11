/**
 * Bring-your-own-LLM: key storage, provider selection, metering.
 *
 * The rest of the application should import LlmRegistry and nothing else from
 * this package. Concrete providers are exported for tests and for wiring in
 * apps/api -- not for use at call sites.
 */

export * from './types.js';
export * from './config.js';

export { LlmRegistry, type LlmRegistryOptions } from './registry.js';
export { CredentialVault } from './vault.js';
export {
  QuotaService,
  currentWindowStart,
  currentWindowEnd,
  platformCostMicroUsd,
} from './quota.js';

export { EnvMasterKeyProvider, type MasterKeyProvider } from './crypto/master-key.js';
export { encryptSecret, decryptSecret, last4, type EncryptedPayload } from './crypto/encryption.js';

export { OpenAiProvider } from './providers/openai.js';
export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './providers/anthropic.js';
