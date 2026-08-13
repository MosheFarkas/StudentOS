import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, last4 } from './encryption.js';
import { EnvMasterKeyProvider, type MasterKeyProvider } from './master-key.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const keys = new EnvMasterKeyProvider(KEY);

const SECRET = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips', async () => {
    const payload = await encryptSecret(SECRET, keys);
    expect(await decryptSecret(payload, keys)).toBe(SECRET);
  });

  it('never stores the plaintext', async () => {
    const payload = await encryptSecret(SECRET, keys);
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain('sk-proj');
  });

  /**
   * The load-bearing property. Reusing an IV under one key in GCM leaks
   * plaintext and destroys authenticity, so a regression that made the IV
   * deterministic would be catastrophic and completely invisible -- every
   * round-trip test would still pass.
   */
  it('uses a fresh IV for every encryption', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => encryptSecret(SECRET, keys)),
    );

    expect(new Set(results.map((r) => r.iv)).size).toBe(50);
    // Same plaintext, same key, different ciphertext -- which is only true if
    // the IV actually varies.
    expect(new Set(results.map((r) => r.ciphertext)).size).toBe(50);
  });

  it('rejects tampered ciphertext', async () => {
    const payload = await encryptSecret(SECRET, keys);
    const bytes = Buffer.from(payload.ciphertext, 'base64');
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);

    await expect(
      decryptSecret({ ...payload, ciphertext: bytes.toString('base64') }, keys),
    ).rejects.toThrow();
  });

  it('rejects a tampered auth tag', async () => {
    const payload = await encryptSecret(SECRET, keys);
    const tag = Buffer.from(payload.authTag, 'base64');
    tag.writeUInt8(tag.readUInt8(0) ^ 0xff, 0);

    await expect(
      decryptSecret({ ...payload, authTag: tag.toString('base64') }, keys),
    ).rejects.toThrow();
  });

  it('cannot be decrypted with a different master key', async () => {
    const payload = await encryptSecret(SECRET, keys);
    const attacker = new EnvMasterKeyProvider(OTHER_KEY);
    await expect(decryptSecret(payload, attacker)).rejects.toThrow();
  });

  it('explains itself when the key version is unknown', async () => {
    const payload = await encryptSecret(SECRET, keys);
    // A rotation that did not back-fill old rows lands here. The message has to
    // say what happened, because the symptom is just "decryption failed".
    await expect(decryptSecret({ ...payload, keyVersion: 99 }, keys)).rejects.toThrow(
      /No master key available for version 99/,
    );
  });

  it('supports reading rows written under an older key during rotation', async () => {
    const v1 = Buffer.alloc(32, 1);
    const v2 = Buffer.alloc(32, 2);

    const rotating: MasterKeyProvider = {
      version: 2,
      getKey: async () => v2,
      getKeyByVersion: async (v) => (v === 1 ? v1 : v === 2 ? v2 : null),
    };

    // Written under v1, read after the key moved to v2.
    const old = await encryptSecret(SECRET, {
      version: 1,
      getKey: async () => v1,
      getKeyByVersion: async (v) => (v === 1 ? v1 : null),
    });

    expect(old.keyVersion).toBe(1);
    expect(await decryptSecret(old, rotating)).toBe(SECRET);
    // New writes use the current key.
    expect((await encryptSecret(SECRET, rotating)).keyVersion).toBe(2);
  });
});

describe('EnvMasterKeyProvider', () => {
  it('rejects a key that is not 32 bytes', () => {
    // AES-256 needs exactly 32. A short key would otherwise fail later, deep
    // inside createCipheriv, with a much less useful message.
    expect(() => new EnvMasterKeyProvider(Buffer.alloc(16).toString('base64'))).toThrow(
      /exactly 32 bytes/,
    );
  });
});

describe('last4', () => {
  it('returns only the last four characters', () => {
    expect(last4(SECRET)).toBe('6789');
    expect(last4(SECRET)).toHaveLength(4);
  });
});
