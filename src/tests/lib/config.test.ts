/**
 * Tests for validateConfig() in src/config.ts
 *
 * validateConfig() reads process.env at call time (not at import time), so
 * we can safely manipulate process.env between tests without re-importing the
 * module.
 *
 * Each test sets up the subset of env vars it needs; beforeEach / afterEach
 * save and restore the original environment so tests are fully isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateConfig } from "../../config.js";

// ---------------------------------------------------------------------------
// Env snapshot helpers
// ---------------------------------------------------------------------------

const WATCHED_VARS = [
  "SPENDEX_DEV",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "MCP_TOKEN_SALT",
] as const;

type Snapshot = Partial<Record<(typeof WATCHED_VARS)[number], string | undefined>>;

let snapshot: Snapshot = {};

beforeEach(() => {
  // Save current values (including undefined)
  for (const key of WATCHED_VARS) {
    snapshot[key] = process.env[key];
  }

  // Default: production-like mode (validation runs) with all vars missing.
  // Individual tests will set only what they need.
  delete process.env["SPENDEX_DEV"];
  for (const key of WATCHED_VARS) {
    delete process.env[key];
  }
});

afterEach(() => {
  // Restore original values
  for (const key of WATCHED_VARS) {
    const original = snapshot[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

// ---------------------------------------------------------------------------
// Helper: set all required vars to valid values
// ---------------------------------------------------------------------------

function setAllValid(): void {
  process.env["SUPABASE_URL"] = "https://abc.supabase.co";
  process.env["SUPABASE_SERVICE_KEY"] = "some-service-key";
  process.env["STRIPE_SECRET_KEY"] = "sk_test_abc123";
  process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_abc123";
  process.env["MCP_TOKEN_SALT"] = "a".repeat(32);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateConfig()", () => {
  it("1. all required vars present — does not throw", () => {
    setAllValid();
    expect(() => validateConfig()).not.toThrow();
  });

  it("2. missing SUPABASE_URL — throws with 'SUPABASE_URL' in message", () => {
    setAllValid();
    delete process.env["SUPABASE_URL"];

    expect(() => validateConfig()).toThrow(/SUPABASE_URL/);
  });

  it("3. SUPABASE_URL present but does not start with 'https://' — throws with 'https://'", () => {
    setAllValid();
    process.env["SUPABASE_URL"] = "http://abc.supabase.co"; // wrong scheme

    expect(() => validateConfig()).toThrow(/https:\/\//);
  });

  it("4. missing STRIPE_SECRET_KEY — throws with 'STRIPE_SECRET_KEY' in message", () => {
    setAllValid();
    delete process.env["STRIPE_SECRET_KEY"];

    expect(() => validateConfig()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("5. STRIPE_SECRET_KEY present but does not start with 'sk_' or 'rk_' — throws", () => {
    setAllValid();
    process.env["STRIPE_SECRET_KEY"] = "pk_test_badkey"; // wrong prefix (publishable key)

    expect(() => validateConfig()).toThrow(/sk_/);
  });

  it("6. SPENDEX_DEV=true — never throws even if all vars are missing", () => {
    process.env["SPENDEX_DEV"] = "true";
    // All required vars remain deleted from beforeEach

    expect(() => validateConfig()).not.toThrow();
  });
});
