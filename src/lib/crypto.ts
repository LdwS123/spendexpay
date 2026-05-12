/**
 * Symmetric encryption for managed-account credentials at rest.
 *
 * Spendex Pay creates real signup credentials (email alias + password) on
 * behalf of users so an agent can register accounts at external services. The
 * password is the only piece of long-lived sensitive data we hold for that
 * account — losing it locks the user out, leaking it gives full account access.
 *
 * We use AES-256-GCM with a 12-byte random IV per encryption. Output is
 * `<iv-hex>:<authTag-hex>:<ciphertext-hex>` so a future key rotation can be
 * implemented by prefixing a key-id without breaking the wire format.
 *
 * The key is read from MANAGED_ACCOUNT_ENCRYPTION_KEY at first use. In
 * SPENDEX_DEV mode a zeroed fallback key is used so local development never
 * needs to provision a real key — but the same dev-mode bypass in the tools
 * means encrypted blobs from dev mode never reach production storage.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { DEV_MODE } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;     // AES-256 → 32-byte key
const IV_BYTES = 12;      // GCM standard nonce length
const AUTH_TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

/**
 * Resolve the 32-byte encryption key.
 *
 * Cached after the first successful resolution. Throws a precise error in
 * production if the env var is missing or malformed — silently using a
 * placeholder key would make encrypted rows undecryptable after a real key is
 * configured.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env["MANAGED_ACCOUNT_ENCRYPTION_KEY"];

  if (!raw) {
    if (DEV_MODE) {
      // Deterministic dev-mode key. Encryption still happens (so the round-trip
      // is exercised in tests) but no real production data ever lands here.
      cachedKey = Buffer.alloc(KEY_BYTES, 0x42);
      return cachedKey;
    }
    throw new Error(
      "MANAGED_ACCOUNT_ENCRYPTION_KEY is not set. Generate one with " +
      "`openssl rand -hex 32` and set it in the environment."
    );
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "hex");
  } catch {
    throw new Error(
      "MANAGED_ACCOUNT_ENCRYPTION_KEY must be a hex string (use `openssl rand -hex 32`)."
    );
  }

  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `MANAGED_ACCOUNT_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes ` +
      `(got ${buf.length}). Use \`openssl rand -hex 32\` to generate a fresh key.`
    );
  }

  cachedKey = buf;
  return cachedKey;
}

/**
 * Encrypt a UTF-8 plaintext.
 *
 * Output format: `<iv>:<authTag>:<ciphertext>`, all hex-encoded. Each call
 * generates a fresh IV so the same plaintext never encrypts to the same blob
 * (defends against frequency analysis of repeated common passwords).
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypt a blob produced by {@link encryptSecret}.
 *
 * Throws if the blob is malformed or the auth tag does not verify — never
 * returns garbage plaintext. Callers must treat a thrown error as "credentials
 * unrecoverable" and surface that to the user.
 */
export function decryptSecret(blob: string): string {
  const parts = blob.split(":");
  if (parts.length !== 3) {
    throw new Error("Encrypted blob has wrong format (expected iv:tag:ciphertext).");
  }
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ctHex, "hex");

  if (iv.length !== IV_BYTES) {
    throw new Error(`Encrypted blob IV has wrong length (got ${iv.length}, expected ${IV_BYTES}).`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(
      `Encrypted blob auth tag has wrong length (got ${authTag.length}, expected ${AUTH_TAG_BYTES}).`
    );
  }

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

// ---------------------------------------------------------------------------
// Credential generators
// ---------------------------------------------------------------------------

const PASSWORD_LOWER = "abcdefghijkmnopqrstuvwxyz";          // no 'l'
const PASSWORD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";           // no 'I', 'O'
const PASSWORD_DIGIT = "23456789";                            // no '0', '1'
// Limited symbol set — many sites reject the full ASCII range.
const PASSWORD_SYMBOL = "!@#$%^&*?_-+=";

const PASSWORD_ALPHABET =
  PASSWORD_LOWER + PASSWORD_UPPER + PASSWORD_DIGIT + PASSWORD_SYMBOL;

/**
 * Generate a cryptographically random password of the given length.
 *
 * Guaranteed to contain at least one lowercase letter, one uppercase letter,
 * one digit, and one symbol — required by most signup forms. Uses
 * `crypto.randomBytes` rejection sampling so the distribution stays uniform
 * even though the alphabet length does not divide 256.
 *
 * @param length  Total characters in the returned password (default 32).
 *                Minimum enforced is 12 — anything shorter is unsafe regardless
 *                of charset.
 */
export function generateSecurePassword(length: number = 32): string {
  if (length < 12) {
    throw new Error(`generateSecurePassword: length must be at least 12 (got ${length}).`);
  }

  // Pick one character from each required class first so the result always
  // satisfies typical "must include …" rules.
  const required = [
    pickRandom(PASSWORD_LOWER),
    pickRandom(PASSWORD_UPPER),
    pickRandom(PASSWORD_DIGIT),
    pickRandom(PASSWORD_SYMBOL),
  ];

  const remainder: string[] = [];
  for (let i = 0; i < length - required.length; i += 1) {
    remainder.push(pickRandom(PASSWORD_ALPHABET));
  }

  const all = [...required, ...remainder];
  // Fisher-Yates with crypto randomness so the required chars are not always
  // at the start (some validators check character positions, but more
  // importantly, predictable positions weaken entropy guarantees).
  for (let i = all.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const ai = all[i] as string;
    const aj = all[j] as string;
    all[i] = aj;
    all[j] = ai;
  }

  return all.join("");
}

/**
 * Generate a short random hex token, used as the suffix on email aliases.
 *
 * 12 hex chars → 48 bits of entropy: plenty to avoid alias collisions even
 * at millions of accounts per user, while staying short enough that the
 * alias still looks like a normal email local-part to merchant signup forms.
 */
export function generateShortHash(bytes: number = 6): string {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pickRandom(alphabet: string): string {
  const idx = randomInt(alphabet.length);
  return alphabet[idx] as string;
}

/**
 * Uniform random integer in [0, max). Uses rejection sampling on 4-byte
 * unsigned ints so the distribution stays exactly uniform regardless of `max`.
 */
function randomInt(max: number): number {
  if (max <= 0 || max > 0xffffffff) {
    throw new Error(`randomInt: max out of range (${max}).`);
  }
  const limit = Math.floor(0x100000000 / max) * max;
  // Loop until we draw a value inside the divisible window. Expected
  // iterations are < 2 for any sensible `max`.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = randomBytes(4).readUInt32BE(0);
    if (value < limit) return value % max;
  }
}
