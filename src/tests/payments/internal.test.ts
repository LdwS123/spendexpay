/**
 * Tests for src/lib/payments/internal.ts
 *
 * Covers the result builders and the HTTP helper that every provider relies on.
 * These are the shared contracts — a bug here breaks every payment method.
 */

import { describe, it, expect } from "vitest";
import {
  chargedResult,
  freeResult,
  pendingApprovalResult,
  parseJsonOrThrow,
} from "../../lib/payments/internal.js";

// ---------------------------------------------------------------------------
// chargedResult
// ---------------------------------------------------------------------------
describe("chargedResult", () => {
  it("returns outcome=charged with the supplied paymentMethod and transactionId", () => {
    const result = chargedResult("stripe_card", "pi_test123");
    expect(result).toEqual({
      outcome: "charged",
      paymentMethod: "stripe_card",
      transactionId: "pi_test123",
    });
  });

  it("works for every supported payment method that produces immediate charges", () => {
    const methods = ["paypal", "ach_bank_transfer", "coinbase_commerce", "usdc_base"] as const;
    for (const method of methods) {
      const r = chargedResult(method, `txn_${method}`);
      expect(r.outcome).toBe("charged");
      expect(r.paymentMethod).toBe(method);
      expect(r.transactionId).toBe(`txn_${method}`);
    }
  });
});

// ---------------------------------------------------------------------------
// freeResult
// ---------------------------------------------------------------------------
describe("freeResult", () => {
  it("returns outcome=free with transactionId prefixed with 'free-'", () => {
    const result = freeResult("stripe_card", "user1-vercel-abc");
    expect(result).toEqual({
      outcome: "free",
      paymentMethod: "stripe_card",
      transactionId: "free-user1-vercel-abc",
    });
  });

  it("includes the idempotencyKey verbatim in the transactionId", () => {
    const key = "user42-netlify-unique-ctx";
    const result = freeResult("paypal", key);
    expect(result.transactionId).toBe(`free-${key}`);
  });

  it("does not set approvalUrl (free actions need no user action)", () => {
    const result = freeResult("stripe_card", "key");
    expect((result as unknown as Record<string, unknown>)["approvalUrl"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pendingApprovalResult
// ---------------------------------------------------------------------------
describe("pendingApprovalResult", () => {
  it("returns outcome=pending with the correct shape", () => {
    const result = pendingApprovalResult(
      "apple_pay",
      "pi_wallet_abc",
      "https://spendexai.com/pay/pi_wallet_abc"
    );
    expect(result).toEqual({
      outcome: "pending",
      paymentMethod: "apple_pay",
      transactionId: "pi_wallet_abc",
      approvalUrl: "https://spendexai.com/pay/pi_wallet_abc",
    });
  });

  it("always includes approvalUrl — never optional in the pending outcome", () => {
    const result = pendingApprovalResult("google_pay", "pi_gp_xyz", "https://example.com/pay/pi_gp_xyz");
    expect(typeof result.approvalUrl).toBe("string");
    expect(result.approvalUrl.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseJsonOrThrow
// ---------------------------------------------------------------------------
describe("parseJsonOrThrow", () => {
  function makeResponse(status: number, body: string): Response {
    return new Response(body, { status });
  }

  it("returns parsed JSON for a 2xx response", async () => {
    const resp = makeResponse(200, JSON.stringify({ foo: "bar" }));
    const data = await parseJsonOrThrow<{ foo: string }>(resp, "TestProvider", "test action");
    expect(data).toEqual({ foo: "bar" });
  });

  it("throws for a 400 response with the provider, action, status, and body in the message", async () => {
    const resp = makeResponse(400, "Bad Request body here");
    await expect(
      parseJsonOrThrow(resp, "Stripe", "charge creation")
    ).rejects.toThrow("Stripe charge creation failed: 400 Bad Request body here");
  });

  it("throws for a 401 response", async () => {
    const resp = makeResponse(401, "Unauthorized");
    await expect(
      parseJsonOrThrow(resp, "PayPal", "auth")
    ).rejects.toThrow("PayPal auth failed: 401 Unauthorized");
  });

  it("throws for a 500 response", async () => {
    const resp = makeResponse(500, "Internal Server Error");
    await expect(
      parseJsonOrThrow(resp, "Coinbase Commerce", "charge creation")
    ).rejects.toThrow("Coinbase Commerce charge creation failed: 500 Internal Server Error");
  });

  it("includes the full response body in the error so operators can diagnose", async () => {
    const detailedBody = JSON.stringify({ error: { code: "card_declined", message: "Insufficient funds" } });
    const resp = makeResponse(402, detailedBody);
    await expect(
      parseJsonOrThrow(resp, "Stripe", "confirm")
    ).rejects.toThrow(detailedBody);
  });
});
