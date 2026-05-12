/**
 * TOTP helpers — wrap `otplib` with our app conventions.
 *
 * Why a thin wrapper?
 *  - centralises the issuer string so it shows up consistently in
 *    authenticator apps (Google Authenticator, 1Password, Authy)
 *  - locks in a 30-second step and a 1-step drift window so we don't
 *    accidentally accept stale codes minutes after they've expired
 *  - hashes recovery codes the same way every route does, so the
 *    setup route and verify route agree on what "matches" means
 *
 * All callers go through this module; no route imports `otplib` directly.
 */

import { generateSecret, generateURI, verifySync } from "otplib";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ISSUER = "Spendex Pay";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_TOLERANCE_SECONDS = 30;

/** Generate a fresh base32 TOTP secret. ~160 bits of entropy. */
export function generateTotpSecret(): string {
  return generateSecret({ length: 20 });
}

/**
 * Build the otpauth:// URI that an authenticator app encodes into a QR
 * code. The `label` part shows up under the account inside the app and
 * usually contains the user's email so they can tell accounts apart.
 */
export function buildOtpAuthUrl(secret: string, accountLabel: string): string {
  return generateURI({
    issuer: ISSUER,
    label: accountLabel,
    secret,
    period: TOTP_PERIOD_SECONDS,
  });
}

/**
 * Verify a 6-digit code against the stored secret. Returns true if the
 * code is valid within our drift window.
 *
 * The code is intentionally typed `string` rather than `number` — leading
 * zeros are significant for TOTP and would be lost in a numeric type.
 */
export function verifyTotpCode(code: string, secret: string): boolean {
  if (!secret) return false;
  // otplib expects the raw 6-digit string; strip whitespace defensively so
  // a user pasting "123 456" still works.
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    return verifySync({
      token: cleaned,
      secret,
      period: TOTP_PERIOD_SECONDS,
      epochTolerance: TOTP_TOLERANCE_SECONDS,
    }).valid;
  } catch {
    // otplib throws on malformed secrets; treat as a failed verification
    // rather than letting the exception bubble to the client.
    return false;
  }
}

// ─── Recovery codes ──────────────────────────────────────────────────────────
//
// 10 codes of the form `XXXX-XXXX-XXXX` (12 hex chars, dashed for readability).
// We show them to the user exactly once at setup time. The DB only stores
// SHA-256 hashes; if the DB leaks, the codes cannot be brute-forced in any
// reasonable time given the ~48 bits of entropy.

const RECOVERY_CODE_COUNT = 10;

export interface GeneratedRecoveryCodes {
  /** Plaintext codes shown to the user. Never persist these. */
  plain: string[];
  /** Hashed codes for DB storage. Same order as `plain`. */
  hashed: string[];
}

export function generateRecoveryCodes(): GeneratedRecoveryCodes {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    // 6 random bytes = 12 hex chars. Dash every 4 for readability.
    const raw = randomBytes(6).toString("hex").toUpperCase();
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    plain.push(code);
    hashed.push(hashRecoveryCode(code));
  }
  return { plain, hashed };
}

/** Stable SHA-256 hash for recovery codes. Lower-cased + dashes stripped so
 *  the user can type the code with or without dashes when redeeming. */
export function hashRecoveryCode(code: string): string {
  const normalised = code.replace(/[-\s]/g, "").toUpperCase();
  return createHash("sha256").update(normalised).digest("hex");
}

/**
 * Constant-time check that a user-supplied code matches one of the stored
 * hashes. Returns the index of the match (so the caller can remove the
 * used code) or -1 if no match.
 */
export function findRecoveryCodeMatch(
  candidate: string,
  storedHashes: readonly string[]
): number {
  const candidateHash = hashRecoveryCode(candidate);
  const candidateBuf = Buffer.from(candidateHash, "hex");
  for (let i = 0; i < storedHashes.length; i += 1) {
    const storedBuf = Buffer.from(storedHashes[i], "hex");
    if (storedBuf.length !== candidateBuf.length) continue;
    if (timingSafeEqual(candidateBuf, storedBuf)) return i;
  }
  return -1;
}
