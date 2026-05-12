/**
 * Tests for src/lib/payments/paypal.ts — PayPalProvider
 *
 * PayPal uses native fetch (not an SDK), so we stub the global `fetch` with
 * vi.stubGlobal. The module-level OAuth token cache (cachedToken) is shared
 * across calls within the same module instance.
 *
 * To keep tests hermetic, we use vi.resetModules() + dynamic import in each
 * test so every test gets a fresh module with an empty token cache.
 *
 * Happy-path fetch sequence (per charge() call):
 *   1. POST /v1/oauth2/token          → access token
 *   2. POST /v2/checkout/orders       → create order
 *   3. POST /v2/checkout/orders/:id/capture → capture order
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock fetch BEFORE any module import.
// vi.hoisted() runs before vi.mock() hoisting, avoiding temporal dead zones.
// ---------------------------------------------------------------------------

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Mock config so no real env vars are needed.
// ---------------------------------------------------------------------------

vi.mock("../../config.js", () => ({
  config: {
    paypal: {
      clientId: "test_client_id",
      clientSecret: "test_secret",
      sandbox: true,
    },
  },
  DEV_MODE: false,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock Response that fetch() can return. */
function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Canonical token response — expires_in = 32400 s (~9 hours). */
const TOKEN_RESPONSE = {
  access_token: "tok",
  token_type: "Bearer",
  expires_in: 32400,
};

/** Canonical create-order response. */
const ORDER_RESPONSE = {
  id: "ORDER_123",
  status: "CREATED",
  purchase_units: [],
};

/** Canonical capture response — fully successful. */
const CAPTURE_RESPONSE = {
  id: "ORDER_123",
  status: "COMPLETED",
  purchase_units: [
    {
      payments: {
        captures: [{ id: "CAP_456", status: "COMPLETED" }],
      },
    },
  ],
};

/** Wire up the happy-path three-fetch sequence onto mockFetch. */
function setupHappyPath(): void {
  mockFetch
    .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE))
    .mockResolvedValueOnce(mockResponse(ORDER_RESPONSE))
    .mockResolvedValueOnce(mockResponse(CAPTURE_RESPONSE));
}

// ---------------------------------------------------------------------------
// Shared base charge params
// ---------------------------------------------------------------------------

const BASE_PARAMS = {
  userId: "u1",
  amountUsd: 10,
  description: "test",
  idempotencyKey: "ik-1",
  metadata: {},
  providerCustomerId: "B-AGREEMENT123" as any,
};

// ---------------------------------------------------------------------------
// Reset state before each test.
//
// vi.resetModules() clears the module registry so the next dynamic import()
// of paypal.ts gets a fresh module instance with an empty cachedToken.
// This is the only reliable way to reset module-level state without patching
// the source.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// Tests — each test dynamically imports PayPalProvider so it gets a fresh
// module with no cached token.
// ---------------------------------------------------------------------------

describe("PayPalProvider.charge — happy path", () => {
  it("successful charge returns outcome=charged with the capture ID", async () => {
    setupHappyPath();

    const { PayPalProvider } = await import("../../lib/payments/paypal.js");
    const provider = new PayPalProvider();
    const result = await provider.charge(BASE_PARAMS);

    expect(result.outcome).toBe("charged");
    expect(result.transactionId).toBe("CAP_456");
  });
});

describe("PayPalProvider.charge — OAuth token caching", () => {
  it("uses the cached OAuth token on the second call (token fetch happens only once)", async () => {
    // First charge: token (1) + order (2) + capture (3)
    setupHappyPath();
    // Second charge: token is cached — order (4) + capture (5) only
    mockFetch
      .mockResolvedValueOnce(mockResponse(ORDER_RESPONSE))
      .mockResolvedValueOnce(mockResponse(CAPTURE_RESPONSE));

    const { PayPalProvider } = await import("../../lib/payments/paypal.js");
    const provider = new PayPalProvider();
    await provider.charge(BASE_PARAMS);
    await provider.charge({ ...BASE_PARAMS, idempotencyKey: "ik-2" });

    // 3 fetches for the first charge + 2 for the second = 5 total, NOT 6
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});

describe("PayPalProvider.charge — create order failure", () => {
  it("throws when create order returns a non-2xx status (error message contains status code)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(mockResponse("Bad Request", 400));

    const { PayPalProvider } = await import("../../lib/payments/paypal.js");
    const provider = new PayPalProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("400");
  });
});

describe("PayPalProvider.charge — capture status validation", () => {
  it("throws when capture status is not COMPLETED (e.g. PENDING)", async () => {
    const pendingCapture = {
      id: "ORDER_123",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [{ id: "CAP_PEND", status: "PENDING" }],
          },
        },
      ],
    };

    mockFetch
      .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(mockResponse(ORDER_RESPONSE))
      .mockResolvedValueOnce(mockResponse(pendingCapture));

    const { PayPalProvider } = await import("../../lib/payments/paypal.js");
    const provider = new PayPalProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("PENDING");
  });

  it("throws when the capture record is missing from the response", async () => {
    const emptyCaptureResponse = {
      id: "ORDER_123",
      status: "COMPLETED",
      purchase_units: [], // no payments / captures
    };

    mockFetch
      .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(mockResponse(ORDER_RESPONSE))
      .mockResolvedValueOnce(mockResponse(emptyCaptureResponse));

    const { PayPalProvider } = await import("../../lib/payments/paypal.js");
    const provider = new PayPalProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow("missing capture record");
  });
});

describe("PayPalProvider.charge — token fetch failure", () => {
  it("throws when the OAuth token endpoint returns 401", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("Unauthorized", 401));

    const { PayPalProvider } = await import("../../lib/payments/paypal.js");
    const provider = new PayPalProvider();
    await expect(provider.charge(BASE_PARAMS)).rejects.toThrow();
  });
});
