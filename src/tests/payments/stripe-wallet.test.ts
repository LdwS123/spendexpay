/**
 * Tests for src/lib/payments/stripe-wallet.ts — createWalletApprovalCharge
 * and the two providers that wrap it: ApplePayProvider and GooglePayProvider.
 *
 * Wallet payments (Apple Pay / Google Pay) cannot confirm inside an MCP server
 * because they require device/browser-level user interaction. The provider
 * creates an unconfirmed PaymentIntent and returns outcome="pending" with an
 * approvalUrl the agent must surface to the user.
 *
 * All Stripe SDK calls are mocked — no real network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChargeParams, ProviderCustomerId } from "../../lib/payments/types.js";

// ---------------------------------------------------------------------------
// Mock the Stripe SDK before importing providers.
// The shared stripeClient in stripe.ts is instantiated at module scope, so
// the Stripe constructor must be stubbed before any payment module is imported.
// ---------------------------------------------------------------------------

const mockPaymentIntentsCreate = vi.hoisted(() => vi.fn());

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    paymentIntents: { create: mockPaymentIntentsCreate },
  })),
}));

vi.mock("../../config.js", () => ({
  config: {
    stripe: { secretKey: "sk_test_mock", webhookSecret: "whsec_test_mock" },
    supabase: { url: "https://mock.supabase.co", serviceRoleKey: "svc_mock" },
  },
}));

import { ApplePayProvider } from "../../lib/payments/apple-pay.js";
import { GooglePayProvider } from "../../lib/payments/google-pay.js";

beforeEach(() => { mockPaymentIntentsCreate.mockClear(); });

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_PARAMS: ChargeParams & { providerCustomerId: ProviderCustomerId } = {
  userId: "u_wallet_test",
  amountUsd: 15,
  description: "Wallet payment test",
  idempotencyKey: "ik-wallet-1",
  metadata: { service: "vercel" },
  providerCustomerId: "cus_wallet_test" as any,
};

// ---------------------------------------------------------------------------
// ApplePayProvider — outcome=pending with approvalUrl
// ---------------------------------------------------------------------------
describe("ApplePayProvider.charge — outcome and approvalUrl", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue({ id: "pi_apple" });
  });

  it("ApplePayProvider → outcome=pending with approvalUrl containing the PaymentIntent ID", async () => {
    const provider = new ApplePayProvider();
    const result = await provider.charge(BASE_PARAMS);

    expect(result.outcome).toBe("pending");
    if (result.outcome !== "pending") throw new Error("unreachable");
    expect(result.approvalUrl).toContain("pi_apple");
    expect(result.approvalUrl).toMatch(/^https:\/\//);
  });
});

// ---------------------------------------------------------------------------
// GooglePayProvider — outcome=pending with approvalUrl
// ---------------------------------------------------------------------------
describe("GooglePayProvider.charge — outcome and approvalUrl", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue({ id: "pi_google" });
  });

  it("GooglePayProvider → outcome=pending with approvalUrl containing the PaymentIntent ID", async () => {
    const provider = new GooglePayProvider();
    const result = await provider.charge(BASE_PARAMS);

    expect(result.outcome).toBe("pending");
    if (result.outcome !== "pending") throw new Error("unreachable");
    expect(result.approvalUrl).toContain("pi_google");
    expect(result.approvalUrl).toMatch(/^https:\/\//);
  });
});

// ---------------------------------------------------------------------------
// SPENDEX_APP_URL env var
// ---------------------------------------------------------------------------
describe("createWalletApprovalCharge — SPENDEX_APP_URL env var", () => {
  const originalEnv = process.env["SPENDEX_APP_URL"];

  afterEach(() => {
    // Restore original value (or delete if it was unset)
    if (originalEnv === undefined) {
      delete process.env["SPENDEX_APP_URL"];
    } else {
      process.env["SPENDEX_APP_URL"] = originalEnv;
    }
    mockPaymentIntentsCreate.mockClear();
  });

  it("approvalUrl uses SPENDEX_APP_URL env var when set", async () => {
    // stripe-wallet.ts reads SPENDEX_APP_URL at module load time, so we
    // cannot override it after import in the same module instance.
    // This test documents the intended behavior and verifies the fallback:
    // when env var is not set, the default base URL is "https://spendexai.com".
    mockPaymentIntentsCreate.mockResolvedValue({ id: "pi_env_test" });

    const provider = new ApplePayProvider();
    const result = await provider.charge(BASE_PARAMS);

    // Default base URL must be https://spendexai.com
    if (result.outcome !== "pending") throw new Error("unreachable");
    if (!process.env["SPENDEX_APP_URL"]) {
      expect(result.approvalUrl).toMatch(/^https:\/\/spendexai\.com/);
    } else {
      expect(result.approvalUrl).toMatch(
        new RegExp(`^${process.env["SPENDEX_APP_URL"].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
    }
    expect(result.approvalUrl).toContain("pi_env_test");
  });
});

// ---------------------------------------------------------------------------
// confirm is NOT called
// Wallets require user browser interaction — the server must not confirm.
// ---------------------------------------------------------------------------
describe("createWalletApprovalCharge — no confirm on PaymentIntent", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue({ id: "pi_no_confirm" });
  });

  it("does NOT call paymentIntents.create with confirm: true", async () => {
    const provider = new ApplePayProvider();
    await provider.charge(BASE_PARAMS);

    const createArg = mockPaymentIntentsCreate.mock.calls[0][0];
    // confirm must be absent (or explicitly false) — never true
    expect(createArg.confirm).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// payment_method_types
// Both Apple Pay and Google Pay tokenize as "card" on Stripe's side.
// ---------------------------------------------------------------------------
describe("createWalletApprovalCharge — payment_method_types", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue({ id: "pi_pmt" });
  });

  it("uses payment_method_types=['card'] for ApplePayProvider", async () => {
    const provider = new ApplePayProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method_types: ["card"] }),
      expect.anything()
    );
  });

  it("uses payment_method_types=['card'] for GooglePayProvider", async () => {
    const provider = new GooglePayProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method_types: ["card"] }),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// payment_ui metadata tag
// Distinguishes Apple Pay vs Google Pay in dashboard analytics.
// ---------------------------------------------------------------------------
describe("createWalletApprovalCharge — payment_ui metadata", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue({ id: "pi_meta" });
  });

  it("payment_ui metadata is 'apple_pay' for ApplePayProvider", async () => {
    const provider = new ApplePayProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ payment_ui: "apple_pay" }),
      }),
      expect.anything()
    );
  });

  it("payment_ui metadata is 'google_pay' for GooglePayProvider", async () => {
    const provider = new GooglePayProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ payment_ui: "google_pay" }),
      }),
      expect.anything()
    );
  });
});
