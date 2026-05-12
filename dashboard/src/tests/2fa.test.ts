/**
 * Tests for src/lib/totp.ts — the TOTP and recovery-code primitives.
 *
 * These tests are pure and don't touch the DB. The actual route handlers
 * are thin wrappers around the same primitives, so verifying the
 * primitives gives high confidence that the routes behave correctly.
 */

import { describe, it, expect } from "vitest";
import { generate as otpGenerate } from "otplib";
import {
  generateTotpSecret,
  buildOtpAuthUrl,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  findRecoveryCodeMatch,
} from "../lib/totp";

describe("2FA — TOTP setup", () => {
  it("generates a base32 secret of reasonable length and a parsable otpauth URL", async () => {
    const secret = generateTotpSecret();

    // RFC 4648 base32 alphabet — A-Z and 2-7. Length should be at least
    // 16 characters; our config uses 20 bytes => 32 base32 chars.
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    const url = buildOtpAuthUrl(secret, "user@example.com");
    expect(url.startsWith("otpauth://totp/")).toBe(true);
    expect(url).toContain(encodeURIComponent("Spendex Pay"));
    expect(url).toContain(`secret=${secret}`);

    // A token generated right now against this secret must verify.
    const token = await otpGenerate({ secret, period: 30 });
    expect(verifyTotpCode(token, secret)).toBe(true);
  });
});

describe("2FA — TOTP verify happy path", () => {
  it("accepts a fresh code generated from the same secret", async () => {
    const secret = generateTotpSecret();
    const token = await otpGenerate({ secret, period: 30 });
    expect(verifyTotpCode(token, secret)).toBe(true);

    // Pasting with whitespace must still verify — users often copy " 123 456".
    const spaced = `${token.slice(0, 3)} ${token.slice(3)}`;
    expect(verifyTotpCode(spaced, secret)).toBe(true);
  });
});

describe("2FA — TOTP verify rejects wrong code", () => {
  it("returns false for a code that does not match the secret", async () => {
    const secret = generateTotpSecret();
    const token = await otpGenerate({ secret, period: 30 });

    // Flip one digit. The result has overwhelmingly different value.
    const wrongDigit = token[0] === "0" ? "1" : "0";
    const wrong = wrongDigit + token.slice(1);

    expect(verifyTotpCode(wrong, secret)).toBe(false);
    expect(verifyTotpCode("000000", secret)).toBe(false);
    expect(verifyTotpCode("12345", secret)).toBe(false); // wrong length
    expect(verifyTotpCode("abcdef", secret)).toBe(false); // non-numeric
    expect(verifyTotpCode("", secret)).toBe(false);
  });

  it("returns false when secret is empty", () => {
    expect(verifyTotpCode("123456", "")).toBe(false);
  });
});

describe("2FA — Recovery codes", () => {
  it("generates 10 unique plaintext codes and matching SHA-256 hashes", () => {
    const { plain, hashed } = generateRecoveryCodes();
    expect(plain).toHaveLength(10);
    expect(hashed).toHaveLength(10);
    expect(new Set(plain).size).toBe(10);

    // Each plaintext hashes to its stored hash.
    for (let i = 0; i < 10; i += 1) {
      expect(hashRecoveryCode(plain[i])).toBe(hashed[i]);
    }

    // The hashes are 64 hex chars (SHA-256).
    for (const h of hashed) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("findRecoveryCodeMatch returns the right index, regardless of dashes/case", () => {
    const { plain, hashed } = generateRecoveryCodes();
    const code = plain[3];

    expect(findRecoveryCodeMatch(code, hashed)).toBe(3);
    expect(findRecoveryCodeMatch(code.replace(/-/g, ""), hashed)).toBe(3);
    expect(findRecoveryCodeMatch(code.toLowerCase(), hashed)).toBe(3);
    expect(findRecoveryCodeMatch("0000-0000-0000", hashed)).toBe(-1);
  });
});
