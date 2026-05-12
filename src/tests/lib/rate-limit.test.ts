/**
 * Tests for src/lib/rate-limit.ts — checkRateLimit
 *
 * The rate-limit store is a module-level Map, so tests share state across
 * imports. We avoid cross-test contamination by using a UNIQUE token string
 * per test (via a per-test counter + test name prefix).
 *
 * Time is controlled entirely via vi.useFakeTimers() / vi.setSystemTime().
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { checkRateLimit } from "../../lib/rate-limit.js";

// ---------------------------------------------------------------------------
// Fake timers — must wrap the entire suite so Date.now() is deterministic
// ---------------------------------------------------------------------------

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z").getTime();

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE_TIME));
});

afterAll(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Token factory — each call returns a token that has never been seen before
// ---------------------------------------------------------------------------

let tokenCounter = 0;
function freshToken(label = "tok"): string {
  return `${label}-${++tokenCounter}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Basic allow/block behaviour
// ---------------------------------------------------------------------------

describe("checkRateLimit — first call", () => {
  it("first call is always allowed for a brand-new token", () => {
    const result = checkRateLimit(freshToken("first"));
    expect(result.allowed).toBe(true);
  });
});

describe("checkRateLimit — minute window (limit = 10)", () => {
  it("allows exactly 10 calls within 1 minute", () => {
    const token = freshToken("minute10");
    const results = Array.from({ length: 10 }, () => checkRateLimit(token));
    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it("blocks the 11th call within the same minute", () => {
    const token = freshToken("minute11");
    // Exhaust the 10-call minute budget
    for (let i = 0; i < 10; i++) checkRateLimit(token);
    const result = checkRateLimit(token);
    expect(result.allowed).toBe(false);
  });

  it("retryAfterMs is positive when the minute limit is hit", () => {
    const token = freshToken("retry-positive");
    for (let i = 0; i < 10; i++) checkRateLimit(token);
    const result = checkRateLimit(token);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("retryAfterMs is at most 60 000 ms when the minute limit is hit", () => {
    const token = freshToken("retry-max");
    for (let i = 0; i < 10; i++) checkRateLimit(token);
    const result = checkRateLimit(token);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });
});

// ---------------------------------------------------------------------------
// Token isolation
// ---------------------------------------------------------------------------

describe("checkRateLimit — token isolation", () => {
  it("different tokens are independent — exhausting one does not block another", () => {
    const tokenA = freshToken("isolate-a");
    const tokenB = freshToken("isolate-b");

    // Exhaust tokenA
    for (let i = 0; i < 10; i++) checkRateLimit(tokenA);
    expect(checkRateLimit(tokenA).allowed).toBe(false);

    // tokenB is fresh — must still be allowed
    expect(checkRateLimit(tokenB).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Minute window reset
// ---------------------------------------------------------------------------

describe("checkRateLimit — minute window resets after 60 s", () => {
  it("allows a call after advancing time by 60 001 ms past the window start", () => {
    const token = freshToken("minute-reset");
    vi.setSystemTime(new Date(BASE_TIME));

    // Exhaust the minute budget
    for (let i = 0; i < 10; i++) checkRateLimit(token);
    expect(checkRateLimit(token).allowed).toBe(false);

    // Advance past the minute window
    vi.setSystemTime(new Date(BASE_TIME + 60_001));

    // The minute count should have reset — call is allowed
    expect(checkRateLimit(token).allowed).toBe(true);

    // Reset time for subsequent tests
    vi.setSystemTime(new Date(BASE_TIME));
  });
});

// ---------------------------------------------------------------------------
// Hour limit (limit = 50)
// ---------------------------------------------------------------------------

describe("checkRateLimit — hour window (limit = 50)", () => {
  it("blocks the 51st request when 50 have been made across multiple minute windows", () => {
    const token = freshToken("hour50");
    // Pin time so the hour window doesn't accidentally reset between batches
    let now = BASE_TIME;
    vi.setSystemTime(new Date(now));

    // Make 5 batches of 10, advancing 60 001 ms between each batch to reset
    // the minute window while staying inside the same hour window.
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 10; i++) checkRateLimit(token);
      // Advance minute window (but not hour window) before the next batch
      if (batch < 4) {
        now += 60_001;
        vi.setSystemTime(new Date(now));
      }
    }

    // 51st call — hour budget is exhausted
    const result = checkRateLimit(token);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);

    // Reset time for subsequent tests
    vi.setSystemTime(new Date(BASE_TIME));
  });

  it("allows a call after advancing time by 3 600 001 ms past the hour window start", () => {
    const token = freshToken("hour-reset");
    let now = BASE_TIME;
    vi.setSystemTime(new Date(now));

    // Exhaust the hour budget (5 batches of 10, advancing the minute window each time)
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 10; i++) checkRateLimit(token);
      if (batch < 4) {
        now += 60_001;
        vi.setSystemTime(new Date(now));
      }
    }
    // Verify it is indeed blocked
    expect(checkRateLimit(token).allowed).toBe(false);

    // Advance past the full hour window from the very start
    vi.setSystemTime(new Date(BASE_TIME + 3_600_001));

    // Both windows have reset — call must be allowed
    expect(checkRateLimit(token).allowed).toBe(true);

    // Reset time for subsequent tests
    vi.setSystemTime(new Date(BASE_TIME));
  });
});
