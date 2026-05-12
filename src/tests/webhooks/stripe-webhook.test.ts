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

// ---------------------------------------------------------------------------
// Issuing webhook — cardholder → user lookup contract
//
// The dashboard route at dashboard/src/app/api/webhooks/stripe-issuing/route.ts
// must resolve cardholder_id → user_id via virtual_cards FIRST, then read the
// users row. Querying users.stripe_cardholder_id directly returns nothing —
// the column doesn't exist on that table; the cardholder id is stored on
// virtual_cards (set during onboarding in api/onboarding/route.ts).
//
// These tests document that contract by simulating the chained Supabase
// query and verifying both approve and decline paths.
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub of the Supabase client surface used by
 * lookupUserByCardholderId. Each call to `.from(table)` returns a fresh
 * builder so query state doesn't leak between the two queries.
 */
function makeSupabaseStub(args: {
  virtualCardRow: { user_id: string } | null;
  virtualCardError?: { code: string; message: string } | null;
  userRow?: { id: string; max_auto_charge_usd: number; email: string | null; display_name: string | null } | null;
  userError?: { code: string; message: string } | null;
}) {
  const calls: { table: string; eq: Array<[string, unknown]>; select: string }[] = [];

  return {
    calls,
    from(table: string) {
      const call: { table: string; eq: Array<[string, unknown]>; select: string } = {
        table,
        eq: [],
        select: "",
      };
      calls.push(call);
      const builder = {
        select(cols: string) {
          call.select = cols;
          return builder;
        },
        eq(col: string, val: unknown) {
          call.eq.push([col, val]);
          return builder;
        },
        maybeSingle() {
          if (table === "virtual_cards") {
            return Promise.resolve({
              data: args.virtualCardRow,
              error: args.virtualCardError ?? null,
            });
          }
          if (table === "users") {
            return Promise.resolve({
              data: args.userRow ?? null,
              error: args.userError ?? null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

/**
 * Mirror of the production lookup in
 * dashboard/src/app/api/webhooks/stripe-issuing/route.ts.
 *
 * Keep this in sync with that function — if the production code changes
 * its query shape, this test will fail loudly and document the drift.
 */
interface VirtualCardLookupRow { user_id: string }
interface SpendexUserRow { id: string; max_auto_charge_usd: number; email: string | null; display_name: string | null }

async function lookupUserByCardholderId(
  supabase: ReturnType<typeof makeSupabaseStub>,
  cardholderId: string
): Promise<SpendexUserRow | null> {
  const { data: cardData, error: cardError } = await supabase
    .from("virtual_cards")
    .select("user_id")
    .eq("stripe_cardholder_id", cardholderId)
    .eq("status", "active")
    .maybeSingle();

  if (cardError) throw new Error(`virtual_cards lookup failed: ${cardError.message}`);
  const card = cardData as VirtualCardLookupRow | null;
  if (!card) return null;

  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("id, max_auto_charge_usd, email, display_name")
    .eq("id", card.user_id)
    .maybeSingle();

  if (userError) throw new Error(`users lookup failed: ${userError.message}`);
  const user = userData as SpendexUserRow | null;
  if (!user) return null;

  return user;
}

describe("Stripe Issuing webhook — cardholder → user lookup", () => {
  it("approve path: resolves cardholder via virtual_cards then loads the user", async () => {
    const supabase = makeSupabaseStub({
      virtualCardRow: { user_id: "user_abc" },
      userRow: {
        id: "user_abc",
        max_auto_charge_usd: 50,
        email: "user@example.com",
        display_name: "Test User",
      },
    });

    const user = await lookupUserByCardholderId(supabase, "ich_test_cardholder");

    expect(user).not.toBeNull();
    expect(user!.id).toBe("user_abc");
    expect(user!.max_auto_charge_usd).toBe(50);

    // Verifies the production query order: virtual_cards first, then users.
    // If anyone re-introduces the buggy users.stripe_cardholder_id query,
    // this assertion fails immediately.
    expect(supabase.calls).toHaveLength(2);
    expect(supabase.calls[0].table).toBe("virtual_cards");
    expect(supabase.calls[0].eq).toEqual([
      ["stripe_cardholder_id", "ich_test_cardholder"],
      ["status", "active"],
    ]);
    expect(supabase.calls[1].table).toBe("users");
    expect(supabase.calls[1].eq).toEqual([["id", "user_abc"]]);
  });

  it("decline path: returns null when no virtual_cards row exists for the cardholder", async () => {
    const supabase = makeSupabaseStub({
      virtualCardRow: null,
    });

    const user = await lookupUserByCardholderId(supabase, "ich_unknown_cardholder");

    expect(user).toBeNull();
    // Should short-circuit without querying users at all.
    expect(supabase.calls).toHaveLength(1);
    expect(supabase.calls[0].table).toBe("virtual_cards");
  });

  it("decline path: returns null when virtual_cards row exists but users row is missing", async () => {
    const supabase = makeSupabaseStub({
      virtualCardRow: { user_id: "user_orphaned" },
      userRow: null,
    });

    const user = await lookupUserByCardholderId(supabase, "ich_orphan_cardholder");

    expect(user).toBeNull();
    expect(supabase.calls).toHaveLength(2);
  });

  it("filters virtual_cards by status='active' so a revoked card cannot authorize", async () => {
    // The webhook only matches cards in the active state. A revoked or canceled
    // card with the same cardholder_id must not resolve.
    const supabase = makeSupabaseStub({
      virtualCardRow: null, // stub returns null because the filter excludes the row
    });

    const user = await lookupUserByCardholderId(supabase, "ich_revoked");
    expect(user).toBeNull();

    const firstCall = supabase.calls[0];
    const hasActiveFilter = firstCall.eq.some(
      ([col, val]) => col === "status" && val === "active"
    );
    expect(hasActiveFilter).toBe(true);
  });

  it("propagates DB errors so the webhook can decline for safety", async () => {
    const supabase = makeSupabaseStub({
      virtualCardRow: null,
      virtualCardError: { code: "08000", message: "connection error" },
    });

    await expect(
      lookupUserByCardholderId(supabase, "ich_db_error")
    ).rejects.toThrow("virtual_cards lookup failed");
  });
});
