import { and, eq } from 'drizzle-orm';
import type { Database } from '@studentos/db';
import { llmCredentials } from '@studentos/db';
import type { ByokProvider, CredentialSummary } from '@studentos/shared';
import { StudentOsError } from '@studentos/shared';
import { decryptSecret, encryptSecret, last4 } from './crypto/encryption.js';
import type { MasterKeyProvider } from './crypto/master-key.js';

/**
 * Storage for students' own API keys.
 *
 * The invariant this file exists to hold: plaintext keys are returned by
 * exactly one function (`getDecryptedKey`), which is called only by the
 * provider registry. Everything the HTTP layer can reach returns a
 * CredentialSummary, which carries no key material.
 */
export class CredentialVault {
  constructor(
    private readonly db: Database,
    private readonly keys: MasterKeyProvider,
  ) {}

  async add(input: {
    userId: string;
    provider: ByokProvider;
    label: string;
    apiKey: string;
  }): Promise<CredentialSummary> {
    const encrypted = await encryptSecret(input.apiKey, this.keys);

    const [row] = await this.db
      .insert(llmCredentials)
      .values({
        userId: input.userId,
        provider: input.provider,
        label: input.label,
        last4: last4(input.apiKey),
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
      })
      .returning();

    if (!row) {
      throw new StudentOsError('internal_error', 'Failed to store credential');
    }
    return toSummary(row);
  }

  /** Safe to expose over HTTP -- contains no key material. */
  async list(userId: string): Promise<CredentialSummary[]> {
    const rows = await this.db
      .select()
      .from(llmCredentials)
      .where(eq(llmCredentials.userId, userId));
    return rows.map(toSummary);
  }

  async remove(userId: string, credentialId: string): Promise<void> {
    await this.db
      .delete(llmCredentials)
      .where(and(eq(llmCredentials.id, credentialId), eq(llmCredentials.userId, userId)));
  }

  /**
   * Returns plaintext. Only the provider registry should call this, and the
   * result must never reach a response body, a log line, or an error message.
   */
  async getDecryptedKey(
    userId: string,
  ): Promise<{ provider: ByokProvider; apiKey: string } | null> {
    const [row] = await this.db
      .select()
      .from(llmCredentials)
      .where(eq(llmCredentials.userId, userId))
      .limit(1);

    if (!row) return null;

    const apiKey = await decryptSecret(
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      },
      this.keys,
    );

    await this.db
      .update(llmCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(llmCredentials.id, row.id));

    return { provider: row.provider as ByokProvider, apiKey };
  }
}

function toSummary(row: typeof llmCredentials.$inferSelect): CredentialSummary {
  return {
    id: row.id,
    provider: row.provider as ByokProvider,
    label: row.label,
    last4: row.last4,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}
