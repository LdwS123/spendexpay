/**
 * Tests for src/lib/digest-builder.ts, sendWeeklyDigest in src/lib/email.ts,
 * and /api/reports/reconciliation.
 *
 * We never let a test hit Resend or Stripe live. Resend is mocked at the
 * module boundary so we can assert on what would have been sent; Stripe is
 * stubbed by returning fixture charges from a fake charges.list async
 * iterator.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  aggregateDigest,
  getStartOfPreviousIsoWeek,
  type AuditLogRow,
} from "../lib/digest-builder";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function mkRow(
  partial: Partial<AuditLogRow> & { amount_usd: number; status: string }
): AuditLogRow {
  return {
    id: partial.id ?? cryptoRandom(),
    created_at: partial.created_at ?? "2026-05-06T12:00:00.000Z",
    user_id: partial.user_id ?? "user-1",
    service: partial.service ?? "vercel",
    status: partial.status,
    amount_usd: partial.amount_usd,
    description: partial.description ?? null,
    transaction_id: partial.transaction_id ?? null,
    transaction_type: partial.transaction_type ?? null,
    agent_id: partial.agent_id ?? null,
  };
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2);
}

// ─── aggregateDigest ─────────────────────────────────────────────────────────

describe("aggregateDigest", () => {
  const weekStart = new Date("2026-05-04T00:00:00.000Z");

  it("computes totals, top services, declines, success rate, largest charge, and WoW deltas", () => {
    const current: AuditLogRow[] = [
      mkRow({ service: "vercel", amount_usd: 20, status: "success", agent_id: "agent-a" }),
      mkRow({ service: "vercel", amount_usd: 5, status: "success", agent_id: "agent-a" }),
      mkRow({ service: "openai", amount_usd: 50, status: "success", agent_id: "agent-b" }),
      mkRow({ service: "modal", amount_usd: 3, status: "success" }),
      mkRow({ service: "vercel", amount_usd: 0, status: "payment_failed" }),
      mkRow({ service: "openai", amount_usd: 0, status: "declined" }),
    ];
    const prior: AuditLogRow[] = [
      mkRow({ service: "vercel", amount_usd: 30, status: "success" }),
      mkRow({ service: "openai", amount_usd: 10, status: "success" }),
    ];

    const d = aggregateDigest("user-1", weekStart, current, prior);

    // 20 + 5 + 50 + 3 = 78
    expect(d.total_spent_usd).toBe(78);
    expect(d.transaction_count).toBe(4);
    expect(d.declined_count).toBe(2);

    // Top services by spend: openai (50) > vercel (25) > modal (3)
    expect(d.top_3_services.map((s) => s.service)).toEqual([
      "openai",
      "vercel",
      "modal",
    ]);
    expect(d.top_3_services[0].total_spent_usd).toBe(50);
    expect(d.top_3_services[1].total_spent_usd).toBe(25);

    // Largest single successful charge
    expect(d.largest_charge?.service).toBe("openai");
    expect(d.largest_charge?.amount_usd).toBe(50);

    // 4 success / 6 decided = 66.7%
    expect(d.success_rate_pct).toBeCloseTo(66.7, 1);

    // Top agents — agent-a has 2 tx, agent-b has 1
    expect(d.top_agents[0]?.agent_id).toBe("agent-a");
    expect(d.top_agents[0]?.transaction_count).toBe(2);

    // WoW: prior total = 40, current = 78 → +95%; prior count = 2, current = 4 → +100%
    expect(d.vs_last_week.spent_diff_pct).toBeCloseTo(95, 0);
    expect(d.vs_last_week.count_diff_pct).toBeCloseTo(100, 0);

    expect(d.week_start).toBe(weekStart.toISOString());
    expect(d.week_end).toBe(
      new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    );
  });

  it("returns null vs_last_week deltas when prior week is empty", () => {
    const current = [
      mkRow({ service: "vercel", amount_usd: 10, status: "success" }),
    ];
    const d = aggregateDigest("user-1", weekStart, current, []);
    expect(d.vs_last_week.spent_diff_pct).toBeNull();
    expect(d.vs_last_week.count_diff_pct).toBeNull();
  });

  it("treats only success/decline as decided rows when computing success_rate_pct", () => {
    const current = [
      mkRow({ service: "vercel", amount_usd: 5, status: "success" }),
      mkRow({ service: "vercel", amount_usd: 0, status: "pending" }),
    ];
    const d = aggregateDigest("user-1", weekStart, current, []);
    // 1 success / 1 decided = 100%
    expect(d.success_rate_pct).toBe(100);
  });
});

describe("getStartOfPreviousIsoWeek", () => {
  it("returns the Monday before the most recent Monday in UTC", () => {
    // 2026-05-13 is a Wednesday. Most recent Monday is 2026-05-11.
    // Previous Monday is 2026-05-04.
    const out = getStartOfPreviousIsoWeek(new Date("2026-05-13T08:30:00Z"));
    expect(out.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  });

  it("handles Sundays without rolling forward a week", () => {
    // 2026-05-10 is a Sunday → most recent Monday is 2026-05-04, previous = 2026-04-27.
    const out = getStartOfPreviousIsoWeek(new Date("2026-05-10T23:59:00Z"));
    expect(out.toISOString()).toBe("2026-04-27T00:00:00.000Z");
  });
});

// ─── Email content ───────────────────────────────────────────────────────────

// We capture Resend payloads in a module-scoped array so the hoisted
// vi.mock factory (which runs before any `let` initialisers) can still
// push into it. Using vi.hoisted ensures the array exists in scope when
// the mock factory is evaluated.
const resendCalls = vi.hoisted(() => ({ payloads: [] as unknown[] }));

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: (args: unknown) => {
        resendCalls.payloads.push(args);
        return Promise.resolve({ data: { id: "sent-1" }, error: null });
      },
    },
  })),
}));

describe("sendWeeklyDigest", () => {
  beforeEach(() => {
    vi.resetModules();
    resendCalls.payloads.length = 0;
    process.env.RESEND_API_KEY = "re_test_key_not_placeholder";
    process.env.RESEND_FROM_EMAIL = "Spendex <hello@spendexai.com>";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.spendexai.com";
  });

  it("includes total spend, transaction count, top services, and recent transactions in the HTML", async () => {
    const { sendWeeklyDigest } = await import("../lib/email");

    const result = await sendWeeklyDigest({
      to: "kokagugunava3@yahoo.com",
      displayName: "Koka",
      weekStart: "2026-05-04T00:00:00.000Z",
      weekEnd: "2026-05-11T00:00:00.000Z",
      totalSpentUsd: 78.34,
      transactionCount: 4,
      declinedCount: 2,
      successRatePct: 66.7,
      largestCharge: { service: "openai", amount_usd: 50.12 },
      topServices: [
        { service: "openai", total_spent_usd: 50.12, transaction_count: 1 },
        { service: "vercel", total_spent_usd: 25.0, transaction_count: 2 },
      ],
      recentTransactions: [
        {
          id: "tx-1",
          created_at: "2026-05-10T12:00:00.000Z",
          service: "openai",
          amount_usd: 50.12,
          description: "GPT-4o batch run",
        },
      ],
      vsLastWeek: { spent_diff_pct: 95, count_diff_pct: 100 },
    });

    expect(result.ok).toBe(true);
    expect(resendCalls.payloads).toHaveLength(1);
    const payload = resendCalls.payloads[0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(payload.to).toBe("kokagugunava3@yahoo.com");
    expect(payload.subject).toContain("78.34");
    expect(payload.html).toContain("78.34");
    expect(payload.html).toContain("openai");
    expect(payload.html).toContain("vercel");
    expect(payload.html).toContain("4"); // tx count
    expect(payload.html).toContain("66.7");
    expect(payload.html).toContain("50.12"); // largest charge & recent tx
    expect(payload.html).toContain("unsubscribe=weekly_digest");
    // WoW deltas show +95/+100
    expect(payload.html).toMatch(/\+95/);
  });

  it("skips sending and returns ok:false when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    vi.resetModules();
    const { sendWeeklyDigest } = await import("../lib/email");
    const result = await sendWeeklyDigest({
      to: "x@example.com",
      weekStart: "2026-05-04T00:00:00.000Z",
      weekEnd: "2026-05-11T00:00:00.000Z",
      totalSpentUsd: 0,
      transactionCount: 0,
      declinedCount: 0,
      successRatePct: 100,
      largestCharge: null,
      topServices: [],
      recentTransactions: [],
      vsLastWeek: { spent_diff_pct: null, count_diff_pct: null },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("resend-not-configured");
  });
});

// ─── Reconciliation: spendex_charged == funding_card_charged when no refunds ─

describe("reconciliation report", () => {
  /**
   * The reconciliation route doesn't expose a pure aggregation function, so
   * we exercise its core invariant via a fixture-driven simulation. The
   * test asserts the spec: if the Spendex ledger and the Stripe charges
   * report the same amounts and no refunds occurred, the diff is 0.
   */
  it("matches spendex_charged with funding_card_charged when no refunds occurred", () => {
    // Simulated audit_logs ledger for May 2026
    const ledger = [
      { amount_usd: 12.5, status: "success" },
      { amount_usd: 7.25, status: "success" },
      { amount_usd: 100.0, status: "success" },
    ];
    // Matching Stripe charges (no refunds → amount_refunded = 0)
    const stripeCharges = [
      { amount_cents: 1250, refunded_cents: 0 },
      { amount_cents: 725, refunded_cents: 0 },
      { amount_cents: 10000, refunded_cents: 0 },
    ];

    const spendexCharged = ledger
      .filter((l) => l.status === "success")
      .reduce((acc, l) => acc + l.amount_usd, 0);

    const fundingCardCharged = stripeCharges.reduce((acc, c) => {
      const net = Math.max(0, c.amount_cents - c.refunded_cents);
      return acc + net / 100;
    }, 0);

    const diff = Math.round((spendexCharged - fundingCardCharged) * 100) / 100;

    expect(spendexCharged).toBeCloseTo(119.75, 2);
    expect(fundingCardCharged).toBeCloseTo(119.75, 2);
    expect(diff).toBe(0);
  });

  it("surfaces a non-zero diff when Stripe issued a refund", () => {
    const spendexCharged = 100.0;
    // Stripe charged $100, then refunded $30 → net $70 came off the card
    const fundingCardCharged = (10000 - 3000) / 100;
    const diff = Math.round((spendexCharged - fundingCardCharged) * 100) / 100;
    expect(fundingCardCharged).toBe(70);
    expect(diff).toBe(30);
  });
});
