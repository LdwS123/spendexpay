/**
 * Tests for improved error messages in src/lib/replicate.ts
 *
 * We mock global fetch and collapse the 2-second polling delay using
 * vi.useFakeTimers() + vi.advanceTimersByTimeAsync().
 *
 * Three scenarios are covered:
 *   1. prediction.error set + state="failed" → message includes "Replicate prediction failed" and the error text
 *   2. state="canceled"                      → message includes "canceled"
 *   3. polling deadline exceeded (60 s)       → message includes "timed out"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted — mockFetch must be available inside vi.mock factories, which
// run before the top-level import statements are resolved.
// ---------------------------------------------------------------------------

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock config before importing the module under test.
// replicate.ts imports config only indirectly (via ProviderError), but we
// mock it defensively so other imported modules don't crash.
// ---------------------------------------------------------------------------

vi.mock("../../config.js", () => ({
  config: { replicate: { apiToken: "r8_test" } },
  DEV_MODE: false,
}));

// ---------------------------------------------------------------------------
// Stub the global fetch so no real HTTP calls are made.
// ---------------------------------------------------------------------------

vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Imports — AFTER mocks and stubs.
// ---------------------------------------------------------------------------

import { triggerReplicatePrediction } from "../../lib/replicate.js";
import { ProviderError } from "../../lib/provider-error.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Response-like object that mockFetch returns.
 */
function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/**
 * Default params used in every call. replicateToken must be a non-empty
 * string; the actual value doesn't matter because fetch is mocked.
 */
const DEFAULT_PARAMS = {
  modelVersion: "stability-ai/sdxl:abc123",
  inputJson: '{"prompt":"a cat"}',
  replicateToken: "r8_test",
};

// ---------------------------------------------------------------------------
// Fake timers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("replicate.ts — improved error messages", () => {
  it("1. failed state with prediction.error → message includes 'Replicate prediction failed' and error text", async () => {
    // First fetch: create prediction
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ id: "pred_abc", status: "starting", urls: { get: "https://api.replicate.com/v1/predictions/pred_abc" } })
    );
    // Second fetch (first poll): prediction is "failed" with an error message
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ id: "pred_abc", status: "failed", output: null, error: "CUDA out of memory" })
    );

    const promise = triggerReplicatePrediction(DEFAULT_PARAMS);
    // Attach a no-op .catch so the rejection is handled before we drive timers,
    // preventing Vitest's unhandled-rejection tracker from firing.
    promise.catch(() => {});

    // Advance past the 2-second poll interval to trigger the first poll fetch.
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ProviderError)) return false;
      return (
        err.message.includes("Replicate prediction failed") &&
        err.message.includes("CUDA out of memory") &&
        err.message.includes("pred_abc")
      );
    });
  });

  it("2. canceled state → message includes 'canceled' and prediction ID", async () => {
    // First fetch: create prediction
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ id: "pred_xyz", status: "starting", urls: { get: "https://api.replicate.com/v1/predictions/pred_xyz" } })
    );
    // First poll: prediction was canceled
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ id: "pred_xyz", status: "canceled", output: null, error: null })
    );

    const promise = triggerReplicatePrediction(DEFAULT_PARAMS);
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ProviderError)) return false;
      return (
        err.message.includes("canceled") &&
        err.message.includes("pred_xyz")
      );
    });
  });

  it("3. polling timeout after 60 s → message includes 'timed out' and prediction ID", async () => {
    const PRED_ID = "pred_timeout";

    // First fetch: create prediction
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ id: PRED_ID, status: "starting", urls: { get: `https://api.replicate.com/v1/predictions/${PRED_ID}` } })
    );

    // Every subsequent poll returns "processing" so the deadline is never reached
    // by a terminal state — the loop must exhaust the 60-second window on its own.
    mockFetch.mockImplementation(async () =>
      makeJsonResponse({ id: PRED_ID, status: "processing", output: null, error: null })
    );

    const promise = triggerReplicatePrediction(DEFAULT_PARAMS);
    promise.catch(() => {});

    // Advance 62 seconds to blow past the 60-second deadline.
    // Each polling cycle is 2 s, so we need 31+ iterations to exhaust it.
    await vi.advanceTimersByTimeAsync(62_000);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ProviderError)) return false;
      return (
        err.message.includes("timed out") &&
        err.message.includes(PRED_ID)
      );
    });
  });
});
