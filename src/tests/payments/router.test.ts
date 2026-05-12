/**
 * Tests for src/lib/payments/router.ts
 *
 * The router is the single call-site for all payment traffic.
 * Bugs here affect every payment method at once.
 *
 * We mock all providers so no network calls are made and tests are fast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock every provider module before importing the router.
// vi.mock is hoisted to the top of the file by Vitest, so import order is safe.
// ---------------------------------------------------------------------------

vi.mock("../../lib/payments/stripe.js", () => ({
  stripeClient: {},
  StripeProvider: vi.fn().mockImplementation(() => ({
    method: "stripe_card",
    charge: vi.fn().mockResolvedValue({
      outcome: "charged",
      paymentMethod: "stripe_card",
      transactionId: "pi_stripe_mock",
    }),
  })),
}));

vi.mock("../../lib/payments/paypal.js", () => ({
  PayPalProvider: vi.fn().mockImplementation(() => ({
    method: "paypal",
    charge: vi.fn().mockResolvedValue({
      outcome: "charged",
      paymentMethod: "paypal",
      transactionId: "paypal_capture_mock",
    }),
  })),
}));

vi.mock("../../lib/payments/ach.js", () => ({
  AchBankTransferProvider: vi.fn().mockImplementation(() => ({
    method: "ach_bank_transfer",
    charge: vi.fn().mockResolvedValue({
      outcome: "charged",
      paymentMethod: "ach_bank_transfer",
      transactionId: "pi_ach_mock",
    }),
  })),
}));

vi.mock("../../lib/payments/coinbase.js", () => ({
  CoinbaseCommerceProvider: vi.fn().mockImplementation(() => ({
    method: "coinbase_commerce",
    charge: vi.fn().mockResolvedValue({
      outcome: "charged",
      paymentMethod: "coinbase_commerce",
      transactionId: "coinbase_charge_mock",
    }),
  })),
}));

vi.mock("../../lib/payments/usdc-base.js", () => ({
  UsdcBaseProvider: vi.fn().mockImplementation(() => ({
    method: "usdc_base",
    charge: vi.fn().mockResolvedValue({
      outcome: "charged",
      paymentMethod: "usdc_base",
      transactionId: "circle_transfer_mock",
    }),
  })),
}));

vi.mock("../../lib/payments/apple-pay.js", () => ({
  ApplePayProvider: vi.fn().mockImplementation(() => ({
    method: "apple_pay",
    charge: vi.fn().mockResolvedValue({
      outcome: "pending",
      paymentMethod: "apple_pay",
      transactionId: "pi_apple_mock",
      approvalUrl: "https://spendexai.com/pay/pi_apple_mock",
    }),
  })),
}));

vi.mock("../../lib/payments/google-pay.js", () => ({
  GooglePayProvider: vi.fn().mockImplementation(() => ({
    method: "google_pay",
    charge: vi.fn().mockResolvedValue({
      outcome: "pending",
      paymentMethod: "google_pay",
      transactionId: "pi_google_mock",
      approvalUrl: "https://spendexai.com/pay/pi_google_mock",
    }),
  })),
}));

// Import after mocks are set up
import { routePayment } from "../../lib/payments/router.js";
import type { PaymentMethod, ProviderCustomerId } from "../../lib/payments/types.js";

// ---------------------------------------------------------------------------
// Shared test params factory
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<{
  paymentMethod: string;
  amountUsd: number;
  idempotencyKey: string;
}> = {}) {
  return {
    userId: "user_test_001",
    amountUsd: overrides.amountUsd ?? 5.00,
    description: "Deploy to Vercel (test)",
    idempotencyKey: overrides.idempotencyKey ?? "user_test_001-vercel-ctx",
    metadata: { service: "vercel" },
    paymentMethod: (overrides.paymentMethod ?? "stripe_card") as PaymentMethod,
    providerCustomerId: "cus_test123" as ProviderCustomerId,
  };
}

// ---------------------------------------------------------------------------
// $0 short-circuit — provider must never be called
// ---------------------------------------------------------------------------
describe("routePayment — $0 short-circuit", () => {
  it("returns outcome=free without calling any provider when amountUsd is 0", async () => {
    const params = makeParams({ amountUsd: 0, paymentMethod: "stripe_card" });
    const result = await routePayment(params);

    expect(result.outcome).toBe("free");
    expect(result.paymentMethod).toBe("stripe_card");
  });

  it("encodes the idempotencyKey into the free transactionId", async () => {
    const params = makeParams({ amountUsd: 0, idempotencyKey: "user1-netlify-abc123" });
    const result = await routePayment(params);

    expect(result.transactionId).toBe("free-user1-netlify-abc123");
  });

  it("returns free for $0 regardless of which payment method is configured", async () => {
    const methods: PaymentMethod[] = [
      "stripe_card", "paypal", "ach_bank_transfer",
      "coinbase_commerce", "usdc_base", "apple_pay", "google_pay",
    ];
    for (const method of methods) {
      const result = await routePayment(makeParams({ amountUsd: 0, paymentMethod: method }));
      expect(result.outcome).toBe("free");
    }
  });
});

// ---------------------------------------------------------------------------
// Provider routing — correct provider is selected by paymentMethod
// ---------------------------------------------------------------------------
describe("routePayment — provider dispatch", () => {
  it("routes stripe_card to StripeProvider and returns its result", async () => {
    const result = await routePayment(makeParams({ paymentMethod: "stripe_card" }));
    expect(result.outcome).toBe("charged");
    expect(result.paymentMethod).toBe("stripe_card");
    expect(result.transactionId).toBe("pi_stripe_mock");
  });

  it("routes paypal to PayPalProvider and returns its result", async () => {
    const result = await routePayment(makeParams({ paymentMethod: "paypal" }));
    expect(result.outcome).toBe("charged");
    expect(result.paymentMethod).toBe("paypal");
    expect(result.transactionId).toBe("paypal_capture_mock");
  });

  it("routes ach_bank_transfer to AchBankTransferProvider", async () => {
    const result = await routePayment(makeParams({ paymentMethod: "ach_bank_transfer" }));
    expect(result.outcome).toBe("charged");
    expect(result.paymentMethod).toBe("ach_bank_transfer");
  });

  it("routes coinbase_commerce to CoinbaseCommerceProvider", async () => {
    const result = await routePayment(makeParams({ paymentMethod: "coinbase_commerce" }));
    expect(result.outcome).toBe("charged");
    expect(result.paymentMethod).toBe("coinbase_commerce");
  });

  it("routes usdc_base to UsdcBaseProvider", async () => {
    const result = await routePayment(makeParams({ paymentMethod: "usdc_base" }));
    expect(result.outcome).toBe("charged");
    expect(result.paymentMethod).toBe("usdc_base");
  });

  it("routes apple_pay to ApplePayProvider and returns outcome=pending", async () => {
    const result = await routePayment(makeParams({ paymentMethod: "apple_pay" }));
    expect(result.outcome).toBe("pending");
    expect(result.paymentMethod).toBe("apple_pay");
    if (result.outcome === "pending") {
      expect(result.approvalUrl).toMatch(/^https:\/\//);
    }
  });

  it("routes google_pay to GooglePayProvider and returns outcome=pending", async () => {
    const result = await routePayment(makeParams({ paymentMethod: "google_pay" }));
    expect(result.outcome).toBe("pending");
    expect(result.paymentMethod).toBe("google_pay");
  });
});

// ---------------------------------------------------------------------------
// Unsupported payment method
// ---------------------------------------------------------------------------
describe("routePayment — unsupported method", () => {
  it("throws an informative error for an unrecognized payment method", async () => {
    const params = {
      ...makeParams(),
      paymentMethod: "bitcoin_lightning" as PaymentMethod,
    };
    await expect(routePayment(params)).rejects.toThrow(/bitcoin_lightning/);
  });

  it("includes the list of supported methods in the error message", async () => {
    const params = {
      ...makeParams(),
      paymentMethod: "nonexistent_method" as PaymentMethod,
    };
    await expect(routePayment(params)).rejects.toThrow(/stripe_card/);
  });
});

// ---------------------------------------------------------------------------
// Error propagation — provider errors must not be swallowed
// ---------------------------------------------------------------------------
describe("routePayment — error propagation", () => {
  it("re-throws errors from providers without wrapping or swallowing", async () => {
    // mock.results[0].value is the object returned by new StripeProvider() —
    // distinct from mock.instances[0] which is the raw `this` before the factory runs.
    const { StripeProvider } = await import("../../lib/payments/stripe.js");
    const ctor = StripeProvider as ReturnType<typeof vi.fn>;
    const mockInstance = ctor.mock.results[0]?.value as { charge: ReturnType<typeof vi.fn> } | undefined;
    if (!mockInstance?.charge) throw new Error("StripeProvider mock not initialized");

    mockInstance.charge.mockRejectedValueOnce(
      new Error("Stripe charge did not succeed. PaymentIntent pi_fail is in status \"requires_action\".")
    );

    await expect(
      routePayment(makeParams({ paymentMethod: "stripe_card" }))
    ).rejects.toThrow("requires_action");
  });
});
