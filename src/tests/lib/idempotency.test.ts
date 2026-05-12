/**
 * Tests for src/lib/idempotency.ts
 *
 * The in-flight store is a module-level Map, so we import the functions fresh
 * but use unique keys per test to avoid cross-test contamination.
 *
 * Time is controlled via vi.useFakeTimers() for the stale-key test.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  acquireIdempotencyKey,
  releaseIdempotencyKey,
  getInFlightCount,
} from "../../lib/idempotency.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
function freshKey(label = "key"): string {
  return `${label}-${++counter}-${Math.random().toString(36).slice(2)}`;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acquireIdempotencyKey — first call", () => {
  it("1. returns true for a brand-new key", () => {
    const key = freshKey("k1");
    expect(acquireIdempotencyKey(key)).toBe(true);
    // cleanup
    releaseIdempotencyKey(key);
  });
});

describe("acquireIdempotencyKey — duplicate in-flight key", () => {
  it("2. returns false when the same key is acquired again before release", () => {
    const key = freshKey("k1");
    acquireIdempotencyKey(key);
    expect(acquireIdempotencyKey(key)).toBe(false);
    // cleanup
    releaseIdempotencyKey(key);
  });
});

describe("releaseIdempotencyKey — re-acquire after release", () => {
  it("3. returns true after the key has been released", () => {
    const key = freshKey("k1");
    acquireIdempotencyKey(key);
    releaseIdempotencyKey(key);
    expect(acquireIdempotencyKey(key)).toBe(true);
    // cleanup
    releaseIdempotencyKey(key);
  });
});

describe("acquireIdempotencyKey — key isolation", () => {
  it("4. different keys do not interfere — k1 in-flight does not block k2", () => {
    const k1 = freshKey("k1");
    const k2 = freshKey("k2");
    acquireIdempotencyKey(k1);
    expect(acquireIdempotencyKey(k2)).toBe(true);
    // cleanup
    releaseIdempotencyKey(k1);
    releaseIdempotencyKey(k2);
  });
});

describe("acquireIdempotencyKey — stale key expiry", () => {
  it("5. allows re-acquire when key was started more than 30s ago (stale)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const key = freshKey("stale");
    acquireIdempotencyKey(key);

    // Advance time past the 30s window
    vi.advanceTimersByTime(31_000);

    expect(acquireIdempotencyKey(key)).toBe(true);
    // cleanup
    releaseIdempotencyKey(key);
  });
});

describe("getInFlightCount — increments and decrements", () => {
  it("6. count reflects acquired and released keys correctly", () => {
    const k1 = freshKey("count-k1");
    const k2 = freshKey("count-k2");

    const before = getInFlightCount();

    acquireIdempotencyKey(k1);
    expect(getInFlightCount()).toBe(before + 1);

    acquireIdempotencyKey(k2);
    expect(getInFlightCount()).toBe(before + 2);

    releaseIdempotencyKey(k1);
    expect(getInFlightCount()).toBe(before + 1);

    releaseIdempotencyKey(k2);
    expect(getInFlightCount()).toBe(before);
  });
});
