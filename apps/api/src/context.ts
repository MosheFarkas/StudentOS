import { createDatabase, type Database } from '@studentos/db';
import { CredentialVault, EnvMasterKeyProvider, LlmRegistry, QuotaService } from '@studentos/llm';
import { PostgresMemoryStore, PostgresSkillRegistry } from '@studentos/agent';
import { createAuth, type Auth } from './auth.js';
import type { Env } from './env.js';

/**
 * Application wiring.
 *
 * Everything is constructed once at boot and passed down. This is the only
 * place that decides which MasterKeyProvider is used -- swapping the env-var
 * one for a KMS-backed one is a change to this file and nowhere else.
 */
export interface AppContext {
  env: Env;
  db: Database;
  auth: Auth;
  llm: LlmRegistry;
  vault: CredentialVault;
  quota: QuotaService;
  memory: PostgresMemoryStore;
  skills: PostgresSkillRegistry;
}

export function createContext(env: Env): AppContext {
  const db = createDatabase({ url: env.DATABASE_URL });

  const masterKey = new EnvMasterKeyProvider(env.MASTER_ENCRYPTION_KEY);
  const vault = new CredentialVault(db, masterKey);
  const quota = new QuotaService(db, env.PLATFORM_MONTHLY_TOKEN_QUOTA);

  return {
    env,
    db,
    auth: createAuth(db, env),
    vault,
    quota,
    llm: new LlmRegistry({
      vault,
      quota,
      platformApiKey: env.PLATFORM_OPENAI_API_KEY,
    }),
    memory: new PostgresMemoryStore(db),
    skills: new PostgresSkillRegistry(db),
  };
}
