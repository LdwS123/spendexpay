/**
 * Tests for CoinbaseCommerceProvider and UsdcBaseProvider.
 *
 * Both providers use fetch + polling loops, so we:
 *   - stub global fetch with vi.hoisted so it's in place before any module import
 *   - use vi.useFakeTimers() to collapse the polling delays to zero
 *   - mock ../../config.js so neither COINBASE_COMMERCE_API_KEY nor CIRCLE_API_KEY
 *     need to be present in the environment
 *
 * Key implementation details that drive the test design:
 *   Coinbase: PAYMENT_TIMEOUT_MS = 300_000 ms, POLL_INTERVAL_MS = 5_000 ms
 *             terminal status read from timeline[last].status
 *   USDC/Base: timeout = 30_000 ms, poll interval = 2_000 ms
 *             terminal status read from data.state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChargeParams, ProviderCustomerId } from "../../lib/payments/types.js";

// ---------------------------------------------------------------------------
// Mock fetch globally — must be hoisted so it's available before module import
// ---------------------------------------------------------------------------
const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Mock config — prevents runtime errors from missing env vars
// ---------------------------------------------------------------------------
vi.mock("../../config.js", () => ({
  config: {
    coinbase: { commerceApiKey: "test_cc_key" },
    circle: {
      apiKey: "test_circle_key",
      treasuryWalletId: "treasury_wallet_123",
      sandbox: true,
    },
  },
  DEV_MODE: false,
}));

// ---------------------------------------------------------------------------
// Import providers after mocks are registered
// ---------------------------------------------------------------------------
import { CoinbaseCommerceProvider } from "../../lib/payments/coinbase.js";
import { UsdcBaseProvider } from "../../lib/payments/usdc-base.js";

// ---------------------------------------------------------------------------
// Helper: build a well-formed Response from any JSON-serialisable body
// ---------------------------------------------------------------------------
function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Shared charge params
// ---------------------------------------------------------------------------
const baseParams: ChargeParams & { providerCustomerId: ProviderCustomerId } = {
  userId: "u1",
  amountUsd: 5,
  description: "test",
  idempotencyKey: "ik-1",
  metadata: {},
  providerCustomerId: "coinbase_wallet_ref" as unknown as ProviderCustomerId,
};

// ---------------------------------------------------------------------------
// Coinbase Commerce response fixtures
// ---------------------------------------------------------------------------
const createChargeSuccess = {
  data: {
    id: "charge_uuid",
    code: "XYZ123",
    hosted_url: "https://commerce.coinbase.com/charges/XYZ123",
    timeline: [{ status: "NEW" }],
  },
};

function pollResponse(statuses: string[]) {
  return {
    data: {
      id: "charge_uuid",
      code: "XYZ123",
      hosted_url: "https://commerce.coinbase.com/charges/XYZ123",
      timeline: statuses.map((s) => ({ status: s })),
    },
  };
}

// ---------------------------------------------------------------------------
// COINBASE COMMERCE TESTS
// ---------------------------------------------------------------------------
describe("CoinbaseCommerceProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("immediately COMPLETED on first poll → outcome=charged", async () => {
    // fetch 1: create charge  |  fetch 2: first poll returns COMPLETED
    mockFetch
      .mockResolvedValueOnce(mockResponse(createChargeSuccess))
      .mockResolvedValueOnce(mockResponse(pollResponse(["NEW", "COMPLETED"])));

    const provider = new CoinbaseCommerceProvider();
    const promise = provider.charge(baseParams);

    // Let microtasks run so the first await (createCharge) resolves, then
    // advance time past one poll interval to trigger the first getChargeStatus call.
    await vi.advanceTimersByTimeAsync(5001);

    const result = await promise;

    expect(result.outcome).toBe("charged");
    expect(result.transactionId).toBe("charge_uuid");
    expect(result.paymentMethod).toBe("coinbase_commerce");
  });

  it("polls through PENDING then COMPLETED → outcome=charged", async () => {
    // fetch 1: create  |  fetch 2: PENDING  |  fetch 3: COMPLETED
    mockFetch
      .mockResolvedValueOnce(mockResponse(createChargeSuccess))
      .mockResolvedValueOnce(mockResponse(pollResponse(["NEW", "PENDING"])))
      .mockResolvedValueOnce(mockResponse(pollResponse(["NEW", "PENDING", "COMPLETED"])));

    const provider = new CoinbaseCommerceProvider();
    const promise = provider.charge(baseParams);

    // Advance past poll 1 (PENDING), then poll 2 (COMPLETED)
    await vi.advanceTimersByTimeAsync(5001);
    await vi.advanceTimersByTimeAsync(5001);

    const result = await promise;
    expect(result.outcome).toBe("charged");
    expect(result.transactionId).toBe("charge_uuid");
  });

  it("EXPIRED status → throws with 'declined or expired'", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(createChargeSuccess))
      .mockResolvedValueOnce(mockResponse(pollResponse(["NEW", "EXPIRED"])));

    const provider = new CoinbaseCommerceProvider();
    const promise = provider.charge(baseParams);
    const expectation = expect(promise).rejects.toThrow("declined or expired");

    await vi.advanceTimersByTimeAsync(5001);
    await expectation;
  });

  it("CANCELED status → throws with terminal failure message", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(createChargeSuccess))
      .mockResolvedValueOnce(mockResponse(pollResponse(["NEW", "CANCELED"])));

    const provider = new CoinbaseCommerceProvider();
    const promise = provider.charge(baseParams);
    const expectation = expect(promise).rejects.toThrow(/declined or expired/);

    await vi.advanceTimersByTimeAsync(5001);
    await expectation;
  });

  it("timeout after PAYMENT_TIMEOUT_MS → throws with 'timed out'", async () => {
    const PAYMENT_TIMEOUT_MS = 5 * 60 * 1000; // 300_000

    // Every poll returns PENDING indefinitely.
    // Use mockImplementation so each poll call gets a fresh Response — a single
    // Response body can only be read once, and the loop makes ~60 poll calls.
    mockFetch
      .mockResolvedValueOnce(mockResponse(createChargeSuccess))
      .mockImplementation(() =>
        Promise.resolve(mockResponse(pollResponse(["NEW", "PENDING"])))
      );

    const provider = new CoinbaseCommerceProvider();
    const promise = provider.charge(baseParams);
    const expectation = expect(promise).rejects.toThrow("timed out");

    // Advance well past the 5-minute deadline
    await vi.advanceTimersByTimeAsync(PAYMENT_TIMEOUT_MS + 1000);
    await expectation;
  });

  it("create charge non-2xx → throws with status code in message", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: { message: "Bad Request" } }, 400)
    );

    const provider = new CoinbaseCommerceProvider();

    await expect(provider.charge(baseParams)).rejects.toThrow("400");
  });
});

// ---------------------------------------------------------------------------
// USDC BASE TESTS
// ---------------------------------------------------------------------------

// USDC fixtures
const createTransferSuccess: { data: { id: string; state: string } } = {
  data: { id: "transfer_uuid", state: "running" },
};

function transferPoll(state: string) {
  return { data: { id: "transfer_uuid", state } };
}

const usdcParams: ChargeParams & { providerCustomerId: ProviderCustomerId } = {
  ...baseParams,
  providerCustomerId: "wallet_uuid_123" as unknown as ProviderCustomerId,
};

describe("UsdcBaseProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transfer completes immediately → outcome=charged", async () => {
    // fetch 1: create transfer  |  fetch 2: poll returns "complete"
    mockFetch
      .mockResolvedValueOnce(mockResponse(createTransferSuccess))
      .mockResolvedValueOnce(mockResponse(transferPoll("complete")));

    const provider = new UsdcBaseProvider();
    const promise = provider.charge(usdcParams);

    // Advance past one 2-second poll interval
    await vi.advanceTimersByTimeAsync(2001);

    const result = await promise;

    expect(result.outcome).toBe("charged");
    expect(result.transactionId).toBe("transfer_uuid");
    expect(result.paymentMethod).toBe("usdc_base");
  });

  it("failed state → throws with USDC-related message", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(createTransferSuccess))
      .mockResolvedValueOnce(mockResponse(transferPoll("failed")));

    const provider = new UsdcBaseProvider();
    const promise = provider.charge(usdcParams);
    const expectation = expect(promise).rejects.toThrow(/USDC/i);

    await vi.advanceTimersByTimeAsync(2001);
    await expectation;
  });

  it("timeout after 30s → throws with 'timed out'", async () => {
    // All polls return "running" — never reaches "complete".
    // Use mockImplementation (not mockResolvedValue) so each call gets a fresh
    // Response object — Response bodies can only be read once, and the polling
    // loop reuses the same mock for dozens of calls over the 30-second window.
    mockFetch
      .mockResolvedValueOnce(mockResponse(createTransferSuccess))
      .mockImplementation(() => Promise.resolve(mockResponse(transferPoll("running"))));

    const provider = new UsdcBaseProvider();
    const promise = provider.charge(usdcParams);
    const expectation = expect(promise).rejects.toThrow("timed out");

    // Advance past the 30-second deadline
    await vi.advanceTimersByTimeAsync(31_000);
    await expectation;
  });

  it("HTTP error during polling → keeps polling, eventually succeeds", async () => {
    // fetch 1: create  |  fetch 2: 500 error  |  fetch 3: complete
    mockFetch
      .mockResolvedValueOnce(mockResponse(createTransferSuccess))
      .mockResolvedValueOnce(mockResponse({ error: "internal server error" }, 500))
      .mockResolvedValueOnce(mockResponse(transferPoll("complete")));

    const provider = new UsdcBaseProvider();
    const promise = provider.charge(usdcParams);

    // First poll (500 error) — provider logs and continues
    await vi.advanceTimersByTimeAsync(2001);
    // Second poll (complete)
    await vi.advanceTimersByTimeAsync(2001);

    const result = await promise;
    expect(result.outcome).toBe("charged");
    expect(result.transactionId).toBe("transfer_uuid");
  });

  it("create transfer non-2xx → throws", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: "Internal Server Error" }, 500)
    );

    const provider = new UsdcBaseProvider();

    await expect(provider.charge(usdcParams)).rejects.toThrow();
  });
});
