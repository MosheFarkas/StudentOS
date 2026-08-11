/**
 * Where the master encryption key comes from.
 *
 * v1 reads it from an environment variable. Moving to a KMS (AWS, GCP, Vault)
 * means writing one more implementation of this interface and changing which
 * one gets constructed in apps/api -- no call site touches key material
 * directly, so nothing else has to change.
 */
export interface MasterKeyProvider {
  /** Version written onto every row this key encrypts, for rotation. */
  readonly version: number;
  /** 32 raw bytes for AES-256. Implementations should cache, not re-fetch. */
  getKey(): Promise<Buffer>;
  /**
   * Resolve an older key so previously-written rows stay readable during a
   * rotation. Returns null if that version is unknown.
   */
  getKeyByVersion(version: number): Promise<Buffer | null>;
}

/**
 * Reads the master key from the environment.
 *
 * Suitable for a single self-hosted droplet where the key lives in the systemd
 * unit or a .env file readable only by the service user. It is NOT suitable
 * once more than one person can read the host's environment.
 */
export class EnvMasterKeyProvider implements MasterKeyProvider {
  readonly version = 1;
  readonly #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error(
        `MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}. ` +
          'Generate one with: openssl rand -base64 32',
      );
    }
    this.#key = key;
  }

  async getKey(): Promise<Buffer> {
    return this.#key;
  }

  async getKeyByVersion(version: number): Promise<Buffer | null> {
    return version === this.version ? this.#key : null;
  }
}

/*
 * TODO(security): when the master key moves to a KMS, switch this package to
 * envelope encryption at the same time.
 *
 * The reason is not paranoia about the algorithm -- AES-256-GCM is the same
 * either way. It is that direct encryption requires the master key in
 * application memory, which defeats the point of paying for a KMS. Envelope
 * encryption generates a fresh data key per credential, encrypts the credential
 * with it locally, and asks the KMS only to wrap that data key -- so the master
 * key never leaves the KMS boundary.
 *
 * Concretely that means: two more columns (wrapped_dek, dek_iv) on
 * llm_credentials, and encrypt/decrypt in encryption.ts gaining a wrap/unwrap
 * step. The keyVersion column already present makes the back-fill incremental
 * rather than a flag day.
 *
 * Doing this now would be machinery with nothing behind it, which is why v1
 * ships the simpler scheme.
 */
