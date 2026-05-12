/**
 * Tests for src/lib/retry.ts — withRetry
 *
 * Fake timers are used throughout so the sleep delays collapse instantly.
 * Each test drives time forward explicitly via vi.advanceTimersByTimeAsync().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../../lib/retry.js";
import { ProviderError } from "../../lib/provider-error.js";

// ---------------------------------------------------------------------------
// Fake timers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helper: make a mock function that fails N times then succeeds
// ---------------------------------------------------------------------------

function makeFlakeyFn<T>(
  failCount: number,
  errorFactory: () => unknown,
  successValue: T
): () => Promise<T> {
  let callCount = 0;
  return async () => {
    callCount++;
    if (callCount <= failCount) {
      throw errorFactory();
    }
    return successValue;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  it("1. succeeds on first try — returns result immediately without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const promise = withRetry(fn);
    // No time advance needed — succeeds synchronously on first await
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("2. fails twice, succeeds on third attempt — returns result, fn called 3 times", async () => {
    const rateLimitErr = new ProviderError("rate_limit", "too many requests", "test");
    const fn = makeFlakeyFn(2, () => rateLimitErr, "success");
    const spy = vi.fn(fn);

    // delayMs=1000: attempt 1 fails → sleep 1000ms, attempt 2 fails → sleep 2000ms, attempt 3 succeeds
    const promise = withRetry(spy, { maxAttempts: 3, delayMs: 1000 });

    // Advance past first retry delay (1s)
    await vi.advanceTimersByTimeAsync(1000);
    // Advance past second retry delay (2s)
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe("success");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("3. all attempts fail — rethrows the last error as-is", async () => {
    const err = new ProviderError("server_error", "service down", "test");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, { maxAttempts: 3, delayMs: 100 });
    // Attach a no-op catch immediately so the rejection is always handled,
    // even before we drive time forward. This prevents the
    // PromiseRejectionHandledWarning from vitest's unhandled rejection tracker.
    promise.catch(() => {});

    // Let all retries run: sleep 100ms after attempt 1, 200ms after attempt 2
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    await expect(promise).rejects.toThrow(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("4. rate_limit error is retried by the default retryOn predicate", async () => {
    const rateLimitErr = new ProviderError("rate_limit", "rate limited", "test");
    // Fail once with rate_limit, then succeed
    const fn = makeFlakeyFn(1, () => rateLimitErr, "done");
    const spy = vi.fn(fn);

    const promise = withRetry(spy, { maxAttempts: 3, delayMs: 100 });
    // Advance past the first retry delay
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe("done");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("5. auth error (code='auth') is NOT retried — rethrows immediately on first failure", async () => {
    const authErr = new ProviderError("auth", "invalid token", "test");
    const fn = vi.fn().mockRejectedValue(authErr);

    const promise = withRetry(fn, { maxAttempts: 3, delayMs: 1000 });

    // No time advance — auth errors are rethrown without sleeping
    await expect(promise).rejects.toThrow(authErr);

    // Called exactly once — no retries
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
