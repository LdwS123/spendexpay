/**
 * Tests for src/lib/crypto.ts
 *
 * The MCP server and the dashboard both store and read managed-account
 * passwords using the same on-disk format. If those two diverge, the
 * dashboard's reveal-password page silently fails on every managed account
 * the MCP server has ever created. These tests pin the format down so it
 * cannot drift again.
 *
 * The dashboard's canonical format is base64 of `[12-byte IV][16-byte auth
 * tag][ciphertext]` — see `dashboard/src/lib/crypto.ts`.
 */

import { describe, it, expect } from "vitest";

// The crypto module reads MANAGED_ACCOUNT_ENCRYPTION_KEY at first use, then
// caches it for the rest of the process. Set it BEFORE importing the module
// so the cached value is the deterministic test key — not whatever happens
// to be in the developer's shell.
//
// 0x42 repeated 32 times mirrors the SPENDEX_DEV fallback key exactly. That
// matters for the legacy-format test below: it constructs a blob by hand
// using a literal 0x42*32 key, then asks decryptSecret() to decode it.
process.env["MANAGED_ACCOUNT_ENCRYPTION_KEY"] = "42".repeat(32);

const {
  encryptSecret,
  decryptSecret,
  generateSecurePassword,
  generateShortHash,
} = await import("../../lib/crypto.js");

// ---------------------------------------------------------------------------
// Format expectations — these match the dashboard byte-for-byte.
// ---------------------------------------------------------------------------

describe("encryptSecret — output format", () => {
  it("returns a base64 string with no colon separators", () => {
    const out = encryptSecret("hello world");
    expect(out).not.toContain(":");
    // base64 alphabet: A–Z a–z 0–9 + / = (padding)
    expect(out).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("produces a buffer of length 12 (IV) + 16 (tag) + plaintext.length for AES-GCM", () => {
    const plaintext = "hello world";
    const out = encryptSecret(plaintext);
    const buf = Buffer.from(out, "base64");
    // AES-GCM is a stream cipher: ciphertext length === plaintext length.
    expect(buf.length).toBe(12 + 16 + Buffer.byteLength(plaintext, "utf8"));
  });

  it("produces a fresh IV per call so the same plaintext encrypts differently", () => {
    const a = encryptSecret("same-password");
    const b = encryptSecret("same-password");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("encryptSecret / decryptSecret — round trip", () => {
  it("decrypts back to the original plaintext", () => {
    const original = "StrongPassword!Mock-32-Chars-X";
    const blob = encryptSecret(original);
    expect(decryptSecret(blob)).toBe(original);
  });

  it("round-trips unicode plaintext correctly", () => {
    const original = "café-π-🔐-😀";
    const blob = encryptSecret(original);
    expect(decryptSecret(blob)).toBe(original);
  });

  it("round-trips a long plaintext correctly", () => {
    const original = "x".repeat(1024);
    const blob = encryptSecret(original);
    expect(decryptSecret(blob)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — legacy hex format must still decrypt.
// ---------------------------------------------------------------------------

describe("decryptSecret — legacy hex format compatibility", () => {
  it("still decrypts the old <iv-hex>:<tag-hex>:<ct-hex> format", () => {
    // Construct a legacy blob manually using the same dev-mode key. We do this
    // through Node's crypto directly (not through encryptSecret, which now
    // emits base64) so the legacy decode path is exercised end-to-end.
    const { createCipheriv, randomBytes } = require("node:crypto") as typeof import("node:crypto");
    const key = Buffer.alloc(32, 0x42); // matches dev-mode fallback key
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("legacy-secret", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const legacyBlob = `${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;

    expect(decryptSecret(legacyBlob)).toBe("legacy-secret");
  });

  it("rejects a malformed legacy blob (wrong number of colon-separated parts)", () => {
    expect(() => decryptSecret("only-one-part:two-parts")).toThrow(
      /wrong format/i
    );
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("decryptSecret — error handling", () => {
  it("throws on a base64 payload that is too short to contain IV + tag", () => {
    const tooShort = Buffer.alloc(10).toString("base64");
    expect(() => decryptSecret(tooShort)).toThrow(/too short/i);
  });

  it("throws if the auth tag does not verify (tampered ciphertext)", () => {
    const blob = encryptSecret("real-password");
    const buf = Buffer.from(blob, "base64");
    // Flip a single bit in the ciphertext region.
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01;
    const tampered = buf.toString("base64");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unchanged public APIs — quick smoke checks so callers don't regress.
// ---------------------------------------------------------------------------

describe("generateSecurePassword — public API unchanged", () => {
  it("returns a string of the requested length", () => {
    expect(generateSecurePassword(32)).toHaveLength(32);
    expect(generateSecurePassword(16)).toHaveLength(16);
  });

  it("rejects lengths below the safety floor", () => {
    expect(() => generateSecurePassword(8)).toThrow(/at least 12/);
  });
});

describe("generateShortHash — public API unchanged", () => {
  it("returns a hex string of length 2 * bytes", () => {
    expect(generateShortHash(6)).toMatch(/^[0-9a-f]{12}$/);
    expect(generateShortHash(8)).toMatch(/^[0-9a-f]{16}$/);
  });
});
