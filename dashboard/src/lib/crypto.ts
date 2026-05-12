import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption / decryption for managed-account passwords.
 *
 * Storage format (base64-encoded buffer): [12-byte IV][16-byte authTag][ciphertext]
 *
 * The single key is held in MANAGED_ACCOUNT_ENCRYPTION_KEY and must be a
 * 64-character hex string (32 bytes / 256 bits). Rotate by re-encrypting
 * every row with a new key; never log the key or the plaintext password.
 */

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.MANAGED_ACCOUNT_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "MANAGED_ACCOUNT_ENCRYPTION_KEY is not set. Add it to .env — see .env.example."
    );
  }
  // Accept either 64 hex chars (preferred) or 32-byte base64.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "MANAGED_ACCOUNT_ENCRYPTION_KEY must be 64 hex chars or 32 bytes base64."
    );
  }
  return buf;
}

/**
 * Encrypt a managed-account password for at-rest storage.
 * The caller is responsible for persisting the returned base64 string verbatim.
 */
export function encryptManagedPassword(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt a value previously produced by encryptManagedPassword().
 * Throws if the value is malformed, the auth tag does not verify, or the
 * key is wrong. Callers must NOT log the returned plaintext.
 */
export function decryptManagedPassword(encrypted: string): string {
  const key = getKey();
  const buf = Buffer.from(encrypted, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Encrypted payload is too short to be valid.");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
