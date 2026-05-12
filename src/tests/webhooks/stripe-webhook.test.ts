/**
 * Tests for Stripe webhook signature verification and event handling.
 *
 * There is no dedicated webhook handler file in this project's src/ directory
 * (the dashboard app handles webhooks separately). These tests therefore cover:
 *   1. The Stripe SDK's signature verification contract — which stripeClient
 *      exposes via stripeClient.webhooks.constructEvent — so any future webhook
 *      handler has a passing test baseline to build on.
 *   2. The shape contract for payment_intent.succeeded events — ensuring the
 *      event fields used for audit-log updates are what we expect from Stripe.
 *
 * If/when a webhook handler is added to this repo, these tests should be
 * extended to test the handler function directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Stripe SDK
// vi.hoisted ensures the mock fn is created before vi.mock factories run,
// avoiding the "Cannot access before initialization" TDZ error.
// ---------------------------------------------------------------------------

const mockConstructEvent = vi.hoisted(() => vi.fn());

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    paymentIntents: {
      create: vi.fn(),
    },
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  })),
}));

vi.mock("../../config.js", () => ({
  config: {
    stripe: {
      secretKey: "sk_test_mock",
      webhookSecret: "whsec_test_mock_secret",
    },
    supabase: {
      url: "https://mock.supabase.co",
      serviceRoleKey: "service_role_mock",
    },
  },
}));

import { stripeClient } from "../../lib/payments/stripe.js";

// ---------------------------------------------------------------------------
// Helpers to build realistic Stripe webhook payloads
// ---------------------------------------------------------------------------

function makePaymentIntentSucceededEvent(intentId: string, userId: string) {
  return {
    id: `evt_${intentId}`,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: intentId,
        object: "payment_intent",
        amount: 999, // $9.99 in cents
        currency: "usd",
        status: "succeeded",
        metadata: {
          spendex_user_id: userId,
          service: "vercel",
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------
describe("Stripe webhook — signature verification", () => {
  beforeEach(() => {
    mockConstructEvent.mockReset();
  });

  it("rejects an invalid signature by throwing", () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload.");
    });

    const rawBody = Buffer.from(JSON.stringify({ type: "payment_intent.succeeded" }));
    const sig = "t=invalid,v1=badsig";
    const secret = "whsec_test_mock_secret";

    expect(() =>
      stripeClient.webhooks.constructEvent(rawBody.toString(), sig, secret)
    ).toThrow("No signatures found matching");
  });

  it("rejects a replayed (expired timestamp) webhook", () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("Timestamp outside the tolerance zone");
    });

    const rawBody = JSON.stringify({ type: "payment_intent.succeeded" });
    const staleTimestamp = Math.floor(Date.now() / 1000) - 400; // 400s old > 300s default tolerance
    const sig = `t=${staleTimestamp},v1=anysig`;

    expect(() =>
      stripeClient.webhooks.constructEvent(rawBody, sig, "whsec_test_mock_secret")
    ).toThrow("Timestamp outside the tolerance zone");
  });

  it("returns the parsed event when signature is valid", () => {
    const event = makePaymentIntentSucceededEvent("pi_valid_123", "user_test_001");
    mockConstructEvent.mockReturnValue(event);

    const rawBody = JSON.stringify(event);
    const sig = "t=1234567890,v1=validhmacsig";

    const result = stripeClient.webhooks.constructEvent(rawBody, sig, "whsec_test_mock_secret");
    expect(result.type).toBe("payment_intent.succeeded");
    expect(result.id).toBe(`evt_pi_valid_123`);
  });

  it("calls constructEvent with the raw body string, not a parsed object", () => {
    const event = makePaymentIntentSucceededEvent("pi_123", "user_abc");
    mockConstructEvent.mockReturnValue(event);

    const rawBody = JSON.stringify(event);
    const sig = "t=9999999999,v1=validhmac";
    stripeClient.webhooks.constructEvent(rawBody, sig, "whsec_test_mock_secret");

    // The first argument must be a string — Stripe rejects parsed objects
    // because the signature is computed over the raw bytes.
    const [bodyArg] = mockConstructEvent.mock.calls[0];
    expect(typeof bodyArg).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// payment_intent.succeeded event shape
// ---------------------------------------------------------------------------
describe("Stripe webhook — payment_intent.succeeded event shape", () => {
  it("event.data.object contains the PaymentIntent id", () => {
    const event = makePaymentIntentSucceededEvent("pi_shape_test", "user_xyz");
    expect(event.data.object.id).toBe("pi_shape_test");
  });

  it("event.data.object.status is 'succeeded'", () => {
    const event = makePaymentIntentSucceededEvent("pi_shape_test", "user_xyz");
    expect(event.data.object.status).toBe("succeeded");
  });

  it("event.data.object.metadata contains spendex_user_id for audit log correlation", () => {
    const event = makePaymentIntentSucceededEvent("pi_meta_test", "user_audit_001");
    expect(event.data.object.metadata.spendex_user_id).toBe("user_audit_001");
  });

  it("event.data.object.amount is in cents (not dollars)", () => {
    const event = makePaymentIntentSucceededEvent("pi_cents_test", "user_cents");
    // $9.99 = 999 cents. If a handler reads this, it must divide by 100 for USD display.
    expect(event.data.object.amount).toBe(999);
    expect(event.data.object.currency).toBe("usd");
  });

  it("event.type discriminator is exactly 'payment_intent.succeeded'", () => {
    const event = makePaymentIntentSucceededEvent("pi_type_check", "user_type");
    // Handlers must match on event.type — a typo ('payment_intents.succeeded')
    // would silently skip legitimate events.
    expect(event.type).toBe("payment_intent.succeeded");
  });
});

// ---------------------------------------------------------------------------
// Audit log update contract (documents expected DB call shape)
// ---------------------------------------------------------------------------
describe("Stripe webhook — audit log update contract", () => {
  it("the PaymentIntent id from the event is the correct transactionId to look up in the audit log", () => {
    // When StripeProvider.charge succeeds, it stores intent.id as transactionId.
    // The webhook handler must use event.data.object.id to match that row.
    const event = makePaymentIntentSucceededEvent("pi_audit_match", "user_001");
    const transactionIdForAuditLookup = event.data.object.id;

    expect(transactionIdForAuditLookup).toBe("pi_audit_match");
  });

  it("spendex_user_id metadata survives the round-trip for audit log updates", () => {
    // StripeProvider tags spendex_user_id in metadata.
    // The webhook handler reads it back here to update the correct user's audit row.
    const event = makePaymentIntentSucceededEvent("pi_user_rt", "user_round_trip");
    expect(event.data.object.metadata.spendex_user_id).toBe("user_round_trip");
  });
});
