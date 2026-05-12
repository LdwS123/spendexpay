/**
 * Tests for src/lib/db.ts — getUserByMcpToken & logTransaction
 *
 * We mock @supabase/supabase-js so no real Supabase connection is made.
 * The focus is on the token-branding logic in getUserByMcpToken: a raw
 * Postgres string must be stamped into the correct branded ProviderCustomerId
 * type at the single trust boundary that is db.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must appear before any imports that touch these modules.
// vi.mock is hoisted to the top of the file by Vitest.
//
// vi.hoisted() is also hoisted — values created inside it are available inside
// the vi.mock factory, which runs before module imports are resolved.
// ---------------------------------------------------------------------------

// The single() and insert() return values are swapped out per-test below.
// We expose them as module-level refs so tests can reach them.
const { mockSingle, mockInsert } = vi.hoisted(() => ({
  mockSingle: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: mockSingle,
      update: vi.fn().mockReturnThis(),
      insert: mockInsert,
    }),
  }),
}));

vi.mock("../../config.js", () => ({
  config: {
    supabase: { url: "https://mock.supabase.co", serviceRoleKey: "svc_mock" },
    mcp: { tokenSalt: "test_salt_long_enough_for_tests_abcdef" },
  },
  DEV_MODE: false,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getUserByMcpToken, logTransaction } from "../../lib/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRawRow(overrides: Partial<{
  id: string;
  payment_method: string;
  payment_provider_customer_id: string;
}> = {}) {
  return {
    id: overrides.id ?? "user_123",
    email: "t@t.com",
    payment_method: overrides.payment_method ?? "stripe_card",
    payment_provider_customer_id: overrides.payment_provider_customer_id ?? "cus_abc",
    vercel_token: "v",
    netlify_token: "n",
    railway_token: "r",
    fly_token: "f",
    max_auto_charge_usd: 50,
  };
}

// ---------------------------------------------------------------------------
// Reset mock state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSingle.mockReset();
  mockInsert.mockReset();
  // Default to a successful empty row (tests override as needed)
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockInsert.mockResolvedValue({ error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// getUserByMcpToken — null / error cases
// ---------------------------------------------------------------------------

describe("getUserByMcpToken — PGRST116 (no row found)", () => {
  it("returns null when Supabase returns PGRST116 error", async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: "PGRST116", message: "Row not found" },
    });

    const result = await getUserByMcpToken("bad_token");

    expect(result).toBeNull();
  });
});

describe("getUserByMcpToken — null data with no error", () => {
  it("returns null when data is null even though error is null", async () => {
    mockSingle.mockResolvedValue({ data: null, error: null });

    const result = await getUserByMcpToken("some_token");

    expect(result).toBeNull();
  });
});

describe("getUserByMcpToken — unexpected DB error", () => {
  it("logs to console.error and returns null on an unexpected database error", async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: "INTERNAL_ERROR", message: "Connection refused" },
    });

    const result = await getUserByMcpToken("any_token");

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getUserByMcpToken — branding logic
// ---------------------------------------------------------------------------

describe("getUserByMcpToken — stripe_card branding", () => {
  it("returns the raw string value for a stripe_card user (brand is compile-time only)", async () => {
    const row = makeRawRow({
      payment_method: "stripe_card",
      payment_provider_customer_id: "cus_abc",
    });
    mockSingle.mockResolvedValue({ data: row, error: null });

    const result = await getUserByMcpToken("spx_tok");

    expect(result).not.toBeNull();
    // The branded type is a string at runtime; the value must be preserved exactly.
    expect(result!.payment_provider_customer_id).toBe("cus_abc");
    expect(result!.payment_method).toBe("stripe_card");
  });
});

describe("getUserByMcpToken — ach_bank_transfer branding", () => {
  it("preserves the pm_ string value for an ach_bank_transfer user", async () => {
    const row = makeRawRow({
      payment_method: "ach_bank_transfer",
      payment_provider_customer_id: "pm_abc",
    });
    mockSingle.mockResolvedValue({ data: row, error: null });

    const result = await getUserByMcpToken("spx_tok");

    expect(result).not.toBeNull();
    expect(result!.payment_provider_customer_id).toBe("pm_abc");
    expect(result!.payment_method).toBe("ach_bank_transfer");
  });
});

describe("getUserByMcpToken — paypal branding", () => {
  it("preserves the B- string value for a paypal user", async () => {
    const row = makeRawRow({
      payment_method: "paypal",
      payment_provider_customer_id: "B-abc",
    });
    mockSingle.mockResolvedValue({ data: row, error: null });

    const result = await getUserByMcpToken("spx_tok");

    expect(result).not.toBeNull();
    expect(result!.payment_provider_customer_id).toBe("B-abc");
    expect(result!.payment_method).toBe("paypal");
  });
});

describe("getUserByMcpToken — usdc_base branding", () => {
  it("preserves the UUID string value for a usdc_base user", async () => {
    const row = makeRawRow({
      payment_method: "usdc_base",
      payment_provider_customer_id: "wallet-uuid",
    });
    mockSingle.mockResolvedValue({ data: row, error: null });

    const result = await getUserByMcpToken("spx_tok");

    expect(result).not.toBeNull();
    expect(result!.payment_provider_customer_id).toBe("wallet-uuid");
    expect(result!.payment_method).toBe("usdc_base");
  });
});
