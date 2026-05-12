/**
 * Tests for src/lib/payments/ach.ts — AchBankTransferProvider
 *
 * ACH is async by nature: the expected success status after an off-session
 * confirm is "processing", not "succeeded". Final confirmation arrives via
 * Stripe webhook (payment_intent.succeeded). Any other status means the debit
 * was rejected and must throw.
 *
 * All Stripe SDK calls are mocked — no real network calls are made.
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

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    paymentIntents: { create: mockPaymentIntentsCreate },
  })),
}));

// Mock config so STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET don't need to be set
vi.mock("../../config.js", () => ({
  config: {
    stripe: { secretKey: "sk_test_mock", webhookSecret: "whsec_test_mock" },
    supabase: { url: "https://mock.supabase.co", serviceRoleKey: "svc_mock" },
  },
}));

import { AchBankTransferProvider } from "../../lib/payments/ach.js";

// Clear mock call history before each test so assertions on mock.calls
// always reference only the current test's calls, not accumulated prior calls.
beforeEach(() => { mockPaymentIntentsCreate.mockClear(); });

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_PARAMS: ChargeParams & { providerCustomerId: ProviderCustomerId } = {
  userId: "u1",
  amountUsd: 20,
  description: "ACH test",
  idempotencyKey: "ik-ach-1",
  metadata: {},
  providerCustomerId: "pm_ach_test" as any,
};

function makeIntent(status: string, id = "pi_ach") {
  return { id, status };
}

// ---------------------------------------------------------------------------
// status=processing → outcome=charged
// ACH's normal happy path: debit accepted, settlement pending.
// ---------------------------------------------------------------------------
describe("AchBankTransferProvider.charge — processing (normal ACH success)", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("processing", "pi_ach"));
  });

  it("status=processing → outcome=charged", async () => {
    const provider = new AchBankTransferProvider();
    const result = await provider.charge(BASE_PARAMS);

    expect(result.outcome).toBe("charged");
    expect(result.transactionId).toBe("pi_ach");
  });
});

// ---------------------------------------------------------------------------
// status=succeeded → outcome=charged
// Rare but valid: bank confirmed immediately.
// ---------------------------------------------------------------------------
describe("AchBankTransferProvider.charge — succeeded (rare instant confirmation)", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("succeeded", "pi_ach"));
  });

  it("status=succeeded → outcome=charged", async () => {
    const provider = new AchBankTransferProvider();
    const result = await provider.charge(BASE_PARAMS);

    expect(result.outcome).toBe("charged");
  });
});

// ---------------------------------------------------------------------------
// Non-accepted statuses → throw
// Debit was rejected; must fail hard so the caller knows not to proceed.
// ---------------------------------------------------------------------------
describe("AchBankTransferProvider.charge — rejected statuses throw", () => {
  it("status=requires_action → throws with status and PI ID in message", async () => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("requires_action", "pi_ach_ra"));

    const provider = new AchBankTransferProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("requires_action");
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("pi_ach_ra");
  });

  it("status=requires_payment_method → throws with status and PI ID in message", async () => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("requires_payment_method", "pi_ach_rpm"));

    const provider = new AchBankTransferProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("requires_payment_method");
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("pi_ach_rpm");
  });
});

// ---------------------------------------------------------------------------
// Amount conversion
// ---------------------------------------------------------------------------
describe("AchBankTransferProvider.charge — amount handling", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("processing"));
  });

  it("amount is converted to cents correctly (amountUsd * 100, rounded)", async () => {
    const provider = new AchBankTransferProvider();
    await provider.charge({ ...BASE_PARAMS, amountUsd: 9.99 });

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 999 }),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// mandate_data
// Required by Stripe for ACH debit authorization (dispute defense).
// ---------------------------------------------------------------------------
describe("AchBankTransferProvider.charge — mandate_data", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("processing"));
  });

  it("includes mandate_data in PaymentIntent create call with ip_address: '127.0.0.1'", async () => {
    const provider = new AchBankTransferProvider();
    await provider.charge(BASE_PARAMS);

    const createArg = mockPaymentIntentsCreate.mock.calls[0][0];
    expect(createArg.mandate_data).toBeDefined();
    expect(createArg.mandate_data.customer_acceptance.online.ip_address).toBe("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// payment_method_types
// ---------------------------------------------------------------------------
describe("AchBankTransferProvider.charge — payment_method_types", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("processing"));
  });

  it("includes us_bank_account in payment_method_types", async () => {
    const provider = new AchBankTransferProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method_types: ["us_bank_account"] }),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------
describe("AchBankTransferProvider.charge — idempotency key", () => {
  beforeEach(() => {
    mockPaymentIntentsCreate.mockResolvedValue(makeIntent("processing"));
  });

  it("uses idempotencyKey as Stripe idempotency key (second arg to paymentIntents.create)", async () => {
    const provider = new AchBankTransferProvider();
    await provider.charge(BASE_PARAMS);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "ik-ach-1" })
    );
  });
});
