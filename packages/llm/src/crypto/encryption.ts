import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MasterKeyProvider } from './master-key.js';

const ALGORITHM = 'aes-256-gcm';
/** 96-bit nonce, the size GCM is specified for. */
const IV_BYTES = 12;

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/**
 * Encrypt a student's API key for storage.
 *
 * A fresh random IV per call is load-bearing, not decorative: reusing an IV
 * under the same key in GCM leaks plaintext and destroys authenticity. Never
 * derive the IV from anything -- always random.
 */
export async function encryptSecret(
  plaintext: string,
  keys: MasterKeyProvider,
): Promise<EncryptedPayload> {
  const key = await keys.getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: keys.version,
  };
}

/**
 * Decrypt a stored key.
 *
 * Throws if the ciphertext or auth tag has been tampered with -- GCM verifies
 * on `final()`. Treat a throw here as a security event, not a bad request.
 */
export async function decryptSecret(
  payload: EncryptedPayload,
  keys: MasterKeyProvider,
): Promise<string> {
  const key = await keys.getKeyByVersion(payload.keyVersion);
  if (!key) {
    throw new Error(
      `No master key available for version ${payload.keyVersion}. ` +
        'A key was rotated without back-filling rows encrypted under the old one.',
    );
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** The only part of a key that is ever safe to send to a client. */
export function last4(apiKey: string): string {
  return apiKey.slice(-4);
}
