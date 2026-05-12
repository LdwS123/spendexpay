/**
 * Tests for src/lib/anomaly-detector.ts
 *
 * We mock @supabase/supabase-js so no real Supabase connection is made.
 * Each test installs its own row set on `mockMaybeData` / `mockHeadCount`
 * before invoking the detector. The fluent supabase query builder
 * (.select().eq().eq().gte()…) is faked with a thenable that ultimately
 * resolves to the data the test set up — exactly the shape the real client
 * returns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRows, mockHeadCount, mockError } = vi.hoisted(() => ({
  mockRows: { current: [] as Array<Record<string, unknown>> },
  mockHeadCount: { current: 0 as number },
  mockError: { current: null as null | { code: string; message: string } },
}));

vi.mock("@supabase/supabase-js", () => {
  // The detector chains .select(...).eq(...).gte(...).not(...).
  // We return a thenable that, when awaited, yields `{ data, count, error }`.
  // For head-count queries (select("id", { count: "exact", head: true })) we
  // route to a separate `count` field — the test toggles which is in play.
  function makeBuilder(isHeadCount: boolean): PromiseLike<unknown> & {
    select: (...args: unknown[]) => ReturnType<typeof makeBuilder>;
    eq: (...args: unknown[]) => ReturnType<typeof makeBuilder>;
    gte: (...args: unknown[]) => ReturnType<typeof makeBuilder>;
    not: (...args: unknown[]) => ReturnType<typeof makeBuilder>;
  } {
    const builder: ReturnType<typeof makeBuilder> = {
      select: (_col?: unknown, opts?: unknown) => {
        const head =
          typeof opts === "object" && opts !== null && (opts as { head?: boolean }).head === true;
        return makeBuilder(head);
      },
      eq: () => builder,
      gte: () => builder,
      not: () => builder,
      then: (onFulfilled?: (v: unknown) => unknown) => {
        const value = isHeadCount
          ? { data: null, count: mockHeadCount.current, error: mockError.current }
          : { data: mockRows.current, count: null, error: mockError.current };
        return Promise.resolve(value).then(onFulfilled);
      },
    } as ReturnType<typeof makeBuilder>;
    return builder;
  }

  return {
    createClient: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation(() => makeBuilder(false)),
    }),
  };
});

vi.mock("../../config.js", () => ({
  config: {
    supabase: { url: "https://mock.supabase.co", serviceRoleKey: "svc_mock" },
    mcp: { tokenSalt: "test_salt_long_enough_for_tests_abcdef" },
  },
  DEV_MODE: false,
}));

import {
  detectAmountOutlier,
  detectFastDeclines,
  detectVelocityAnomaly,
} from "../../lib/anomaly-detector.js";

beforeEach(() => {
  mockRows.current = [];
  mockHeadCount.current = 0;
  mockError.current = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// detectFastDeclines
// ---------------------------------------------------------------------------

describe("detectFastDeclines — three sub-second declines", () => {
  it("counts only rows with elapsed < 1000ms and reports the average", async () => {
    const base = Date.now();
    mockRows.current = [
      // Three fast declines (60ms, 80ms, 100ms → avg 80ms)
      {
        created_at: new Date(base).toISOString(),
        decision_made_at: new Date(base + 60).toISOString(),
        status: "declined",
      },
      {
        created_at: new Date(base + 1000).toISOString(),
        decision_made_at: new Date(base + 1080).toISOString(),
        status: "declined",
      },
      {
        created_at: new Date(base + 2000).toISOString(),
        decision_made_at: new Date(base + 2100).toISOString(),
        status: "declined",
      },
      // One genuine "human read it" decline at 30s — should be ignored
      {
        created_at: new Date(base + 3000).toISOString(),
        decision_made_at: new Date(base + 33_000).toISOString(),
        status: "declined",
      },
    ];

    const result = await detectFastDeclines("user_x");

    expect(result.count).toBe(3);
    // (60 + 80 + 100) / 3 = 80
    expect(result.avgMs).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// detectVelocityAnomaly
// ---------------------------------------------------------------------------

describe("detectVelocityAnomaly — over threshold", () => {
  it("returns true when the audit_logs row count meets threshold", async () => {
    mockHeadCount.current = 12;
    const result = await detectVelocityAnomaly("user_x", 60, 10);
    expect(result).toBe(true);
  });
});

describe("detectVelocityAnomaly — under threshold", () => {
  it("returns false when the audit_logs row count is below threshold", async () => {
    mockHeadCount.current = 3;
    const result = await detectVelocityAnomaly("user_x", 60, 10);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectAmountOutlier
// ---------------------------------------------------------------------------

describe("detectAmountOutlier — $500 charge with $20 average", () => {
  it("flags a 10x+ multiplier as outlier", async () => {
    // Five $20 charges → mean $20, $500 is 25× → outlier.
    mockRows.current = [
      { amount_usd: 20, created_at: new Date().toISOString() },
      { amount_usd: 20, created_at: new Date().toISOString() },
      { amount_usd: 20, created_at: new Date().toISOString() },
      { amount_usd: 20, created_at: new Date().toISOString() },
      { amount_usd: 20, created_at: new Date().toISOString() },
    ];

    const result = await detectAmountOutlier("user_x", 500);

    expect(result.isOutlier).toBe(true);
    expect(result.avgAmount).toBe(20);
    expect(result.multiplier).toBe(25);
  });
});

describe("detectAmountOutlier — normal $25 charge with $20 average", () => {
  it("returns isOutlier=false when amount is within range", async () => {
    mockRows.current = [
      { amount_usd: 20, created_at: new Date().toISOString() },
      { amount_usd: 20, created_at: new Date().toISOString() },
    ];

    const result = await detectAmountOutlier("user_x", 25);

    expect(result.isOutlier).toBe(false);
    expect(result.avgAmount).toBe(20);
    expect(result.multiplier).toBe(1.25);
  });
});

// ---------------------------------------------------------------------------
// No anomalies path — covers all three detectors with normal data
// ---------------------------------------------------------------------------

describe("detectFastDeclines + detectVelocityAnomaly — no anomalies", () => {
  it("returns count=0 / false when activity is well within normal bounds", async () => {
    // Fast declines: no declined rows at all in the window.
    mockRows.current = [];
    const fast = await detectFastDeclines("user_x");
    expect(fast.count).toBe(0);
    expect(fast.avgMs).toBe(0);

    // Velocity: 2 tx/h is far below threshold of 10.
    mockHeadCount.current = 2;
    const velocity = await detectVelocityAnomaly("user_x", 60, 10);
    expect(velocity).toBe(false);
  });
});
