/**
 * Tests for src/lib/payments/stripe.ts — StripeProvider
 *
 * All Stripe SDK calls are mocked with vi.mock so no real network calls are made.
 * We test the behavioral contract: what the provider does with Stripe's response,
 * not the internal mechanics of how it calls the SDK.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChargeParams, ProviderCustomerId } from "../../lib/payments/types.js";

// ---------------------------------------------------------------------------
// Mock the Stripe SDK before importing the provider.
// The provider module instantiates stripeClient at module scope, so we must
// stub the Stripe constructor before that module is first imported.
// ---------------------------------------------------------------------------

// vi.hoisted ensures this runs before vi.mock hoisting, avoiding the TDZ error
// that occurs when a const declared in module scope is referenced inside a vi.mock factory.
const mockPaymentIntentsCreate = vi.hoisted(() => vi.fn());

vi.mock("stripe", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      paymentIntents: {
        create: mockPaymentIntentsCreate,
      },
    })),
  };
});

// Mock config so STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET don't need to be set
vi.mock("../../config.js", () => ({
  config: {
    stripe: {
      secretKey: "sk_test_mock",
      webhookSecret: "whsec_test_mock",
    },
    supabase: {
      url: "https://mock.supabase.co",
      serviceRoleKey: "service_role_mock",
    },
  },
}));

import { StripeProvider } from "../../lib/payments/stripe.js";

// Clear mock call history before each test so assertions on mock.calls
// always reference only the current test's calls, not accumulated prior calls.
beforeEach(() => { mockPaymentIntentsCreate.mockClear(); });

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_PARAMS: ChargeParams & { providerCustomerId: ProviderCustomerId } = {
  userId: "user_test_stripe",
  amountUsd: 9.99,
  description: "Deploy to Vercel Pro (test)",
  idempotencyKey: "user_test_stripe-vercel-ctx001",
  metadata: { service: "vercel", tier: "pro" },
  providerCustomerId: "cus_test_stripe_001" as ProviderCustomerId,
};

function makeIntent(status: string, id = "pi_test_001") {
  return { id, status };
}

// ---------------------------------------------------------------------------
// succeeded → outcome=charged
// ---------------------------------------------------------------------------
describe("StripeProvider.charge — succeeded", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("succeeded", "pi_test_success"));
  });

  it("returns outcome=charged when PaymentIntent status is 'succeeded'", async () => {
    const provider = new StripeProvider();
    const result = await provider.charge(BASE_PARAMS);

    expect(result.outcome).toBe("charged");
    expect(result.paymentMethod).toBe("stripe_card");
    expect(result.transactionId).toBe("pi_test_success");
  });

  it("converts amountUsd to cents before calling Stripe", async () => {
    const provider = new StripeProvider();
    await provider.charge({ ...BASE_PARAMS, amountUsd: 12.50 });

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1250 }),
      expect.anything()
    );
  });

  it("passes currency=usd to Stripe", async () => {
    const provider = new StripeProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ currency: "usd" }),
      expect.anything()
    );
  });

  it("sets confirm=true and off_session=true for agent-initiated charges", async () => {
    const provider = new StripeProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ confirm: true, off_session: true }),
      expect.anything()
    );
  });

  it("tags spendex_user_id in metadata so charges are traceable", async () => {
    const provider = new StripeProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ spendex_user_id: "user_test_stripe" }),
      }),
      expect.anything()
    );
  });

  it("passes caller-supplied metadata fields through to Stripe", async () => {
    const provider = new StripeProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ service: "vercel", tier: "pro" }),
      }),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------
describe("StripeProvider.charge — idempotency key", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockClear();
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("succeeded"));
  });

  it("passes idempotencyKey in the request options (second arg to paymentIntents.create)", async () => {
    const provider = new StripeProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "user_test_stripe-vercel-ctx001" })
    );
  });

  it("uses a different key for each distinct charge context", async () => {
    const provider = new StripeProvider();
    const key1 = "user1-vercel-abc";
    const key2 = "user1-netlify-xyz";

    await provider.charge({ ...BASE_PARAMS, idempotencyKey: key1 });
    await provider.charge({ ...BASE_PARAMS, idempotencyKey: key2 });

    const calls = mockPaymentIntentsCreate.mock.calls;
    expect(calls[0][1].idempotencyKey).toBe(key1);
    expect(calls[1][1].idempotencyKey).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Non-succeeded statuses → throw
// ---------------------------------------------------------------------------
describe("StripeProvider.charge — non-succeeded statuses throw", () => {
  const failureStatuses = [
    "requires_action",
    "requires_payment_method",
    "requires_confirmation",
    "processing",
    "canceled",
  ];

  for (const status of failureStatuses) {
    it(`throws when status is '${status}' (funds not captured)`, async () => {
      mockPaymentIntentsCreate.mockResolvedValue(makeIntent(status, `pi_${status.replace(/_/g, "")}`));

      const provider = new StripeProvider();
      await expect(provider.charge(BASE_PARAMS)).rejects.toThrow(status);
    });
  }

  it("includes the PaymentIntent ID in the error so operators can look it up", async () => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("requires_action", "pi_needs_3ds"));

    const provider = new StripeProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("pi_needs_3ds");
  });

  it("includes a Stripe dashboard link in the requires_action error message", async () => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("requires_action", "pi_3ds_abc"));

    const provider = new StripeProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow(
      "https://dashboard.stripe.com/payments/pi_3ds_abc"
    );
  });

  it("throws for requires_payment_method with a helpful message about user action", async () => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("requires_payment_method", "pi_nopm"));

    const provider = new StripeProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("requires_payment_method");
  });
});

// ---------------------------------------------------------------------------
// $0 short-circuit — router handles this, not the provider directly,
// but we verify the provider itself would still call Stripe (the router is
// what skips it). This confirms the responsibility boundary is correct.
// ---------------------------------------------------------------------------
describe("StripeProvider.charge — $0 handling note", () => {
  it("calls Stripe even for $0 (the router, not the provider, owns the free-tier short-circuit)", async () => {
    // The router never calls provider.charge for $0. But if something bypassed
    // the router and called the provider directly, it would hit Stripe with amount=0.
    // This test documents and pins that responsibility boundary.
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("succeeded", "pi_zero"));

    const provider = new StripeProvider();
    const result = await provider.charge({ ...BASE_PARAMS, amountUsd: 0 });

    // If the provider were called directly with $0, it would call Stripe with 0 cents
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 0 }),
      expect.anything()
    );
    // And the result would be "charged" because Stripe returned "succeeded"
    expect(result.outcome).toBe("charged");
  });
});

// ---------------------------------------------------------------------------
// Stripe SDK errors propagate
// ---------------------------------------------------------------------------
describe("StripeProvider.charge — SDK error propagation", () => {
  it("propagates Stripe SDK errors without swallowing them", async () => {
    const sdkError = new Error("Your card was declined.");
    mockPaymentIntentsCreate.mockRejectedValue(sdkError);

    const provider = new StripeProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("Your card was declined.");
  });
});
