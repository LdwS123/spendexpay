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
  providerCustomerId: string;
  metadata: Record<string, string>;
}> = {}) {
  return {
    userId: "user_test_001",
    amountUsd: overrides.amountUsd ?? 5.00,
    description: "Deploy to Vercel (test)",
    idempotencyKey: overrides.idempotencyKey ?? "user_test_001-vercel-ctx",
    metadata: overrides.metadata ?? { service: "vercel" },
    paymentMethod: (overrides.paymentMethod ?? "stripe_card") as PaymentMethod,
    providerCustomerId: (overrides.providerCustomerId ?? "cus_test123") as ProviderCustomerId,
  };
}

// Helper to get the mock charge spy for a provider constructor mock.
async function getChargeSpy(modulePath: string, exportName: string) {
  const mod = await import(modulePath) as Record<string, ReturnType<typeof vi.fn>>;
  const ctor = mod[exportName];
  const instance = ctor.mock.results[0]?.value as { charge: ReturnType<typeof vi.fn> } | undefined;
  if (!instance?.charge) {
    throw new Error(`${exportName} mock not initialized`);
  }
  return instance.charge;
}

// ---------------------------------------------------------------------------
// providerCustomerId forwarding
// ---------------------------------------------------------------------------

describe("routePayment — providerCustomerId forwarding", () => {
  it("passes providerCustomerId to the provider charge method", async () => {
    const chargeSpy = await getChargeSpy("../../lib/payments/stripe.js", "StripeProvider");

    await routePayment(makeParams({
      paymentMethod: "stripe_card",
      providerCustomerId: "cus_forwarded_abc",
    }));

    expect(chargeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ providerCustomerId: "cus_forwarded_abc" })
    );
  });

  it("passes userId to the provider charge method", async () => {
    const chargeSpy = await getChargeSpy("../../lib/payments/stripe.js", "StripeProvider");

    const params = {
      ...makeParams({ paymentMethod: "stripe_card" }),
      userId: "user_specific_789",
    };
    await routePayment(params);

    expect(chargeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_specific_789" })
    );
  });

  it("passes metadata to the provider charge method", async () => {
    const chargeSpy = await getChargeSpy("../../lib/payments/stripe.js", "StripeProvider");

    await routePayment(makeParams({
      paymentMethod: "stripe_card",
      metadata: { service: "netlify" },
    }));

    expect(chargeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { service: "netlify" } })
    );
  });
});

// ---------------------------------------------------------------------------
// outcome=pending
// ---------------------------------------------------------------------------

describe("routePayment — pending outcome", () => {
  it("returns outcome=pending and a defined approvalUrl when the provider returns pending", async () => {
    const result = await routePayment(makeParams({ paymentMethod: "apple_pay" }));

    expect(result.outcome).toBe("pending");
    if (result.outcome === "pending") {
      expect(result.approvalUrl).toBeDefined();
      expect(typeof result.approvalUrl).toBe("string");
      expect(result.approvalUrl.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// $0 free result details
// ---------------------------------------------------------------------------

describe("routePayment — free result details", () => {
  it("free result for $0 preserves the configured paymentMethod", async () => {
    const result = await routePayment(makeParams({ amountUsd: 0, paymentMethod: "paypal" }));

    expect(result.outcome).toBe("free");
    expect(result.paymentMethod).toBe("paypal");
  });

  it("free transactionId encodes idempotencyKey that contains special chars", async () => {
    const key = "user-123-vercel-my/app-1234";
    const result = await routePayment(makeParams({ amountUsd: 0, idempotencyKey: key }));

    expect(result.transactionId).toBe(`free-${key}`);
  });
});
