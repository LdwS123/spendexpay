/**
 * Tests for POST /api/refunds.
 *
 * We mock three boundaries:
 *   - `@/lib/supabase/server`  → controls the authenticated user
 *   - `@/lib/supabase`         → returns a chainable fake admin builder we
 *                                drive via shared `state`
 *   - `stripe`                 → spy on `refunds.create` so no real call
 *                                escapes the test runner
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Fake Supabase admin ────────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;

const state: {
  authedUserId: string | null;
  // Per-table next-resolved row for the next .maybeSingle() / .single() call.
  auditLogRow: AnyRecord | null;
  auditLogError: { message: string } | null;
  existingRefundRow: AnyRecord | null;
  existingRefundError: { message: string } | null;
  insertResultRow: AnyRecord | null;
  insertError: { message: string } | null;
  inserts: Array<{ table: string; values: AnyRecord }>;
} = {
  authedUserId: "user-aaa",
  auditLogRow: null,
  auditLogError: null,
  existingRefundRow: null,
  existingRefundError: null,
  insertResultRow: null,
  insertError: null,
  inserts: [],
};

function makeAuditLogsBuilder() {
  const b: AnyRecord = {};
  b.select = vi.fn(() => b);
  b.eq = vi.fn(() => b);
  b.maybeSingle = vi.fn(async () => ({
    data: state.auditLogRow,
    error: state.auditLogError,
  }));
  return b;
}

function makeRefundRequestsBuilder() {
  const b: AnyRecord = {};
  b.select = vi.fn(() => b);
  b.eq = vi.fn(() => b);
  b.in = vi.fn(() => b);
  b.order = vi.fn(() => b);
  b.limit = vi.fn(() => b);
  b.maybeSingle = vi.fn(async () => ({
    data: state.existingRefundRow,
    error: state.existingRefundError,
  }));
  b.single = vi.fn(async () => ({
    data: state.insertResultRow,
    error: state.insertError,
  }));
  b.insert = vi.fn((values: AnyRecord) => {
    state.inserts.push({ table: "refund_requests", values });
    return b;
  });
  return b;
}

vi.mock("@/lib/supabase", () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table === "audit_logs") return makeAuditLogsBuilder();
      if (table === "refund_requests") return makeRefundRequestsBuilder();
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: state.authedUserId
          ? { user: { id: state.authedUserId } }
          : { user: null },
        error: null,
      }),
    },
  }),
}));

// ─── Stripe mock ────────────────────────────────────────────────────────────

const refundsCreate = vi.fn();

vi.mock("stripe", () => {
  return {
    default: class FakeStripe {
      refunds = { create: refundsCreate };
    },
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/refunds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function resetState() {
  state.authedUserId = "user-aaa";
  state.auditLogRow = null;
  state.auditLogError = null;
  state.existingRefundRow = null;
  state.existingRefundError = null;
  state.insertResultRow = null;
  state.insertError = null;
  state.inserts = [];
  refundsCreate.mockReset();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/refunds", () => {
  beforeEach(() => {
    vi.resetModules();
    resetState();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
  });

  it("creates a pending refund_request when the charge is old (>24h, no auto-refund)", async () => {
    // 3 days ago
    const created = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    state.auditLogRow = {
      id: "audit-1",
      user_id: "user-aaa",
      amount_usd: 12.5,
      transaction_id: "pi_old123",
      status: "success",
      created_at: created,
    };
    state.insertResultRow = {
      id: "refund-1",
      user_id: "user-aaa",
      audit_log_id: "audit-1",
      amount_usd: 12.5,
      reason: "wrong_amount",
      status: "pending",
      created_at: new Date().toISOString(),
      resolved_at: null,
      refunded_amount_usd: null,
      stripe_refund_id: null,
      resolution_note: null,
      transaction_id: "pi_old123",
      user_explanation: null,
    };

    const { POST } = await import("../app/api/refunds/route");
    const res = await POST(
      makeRequest({
        audit_log_id: "audit-1",
        reason: "wrong_amount",
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.refund_request.status).toBe("pending");
    expect(refundsCreate).not.toHaveBeenCalled();

    const ins = state.inserts.find((i) => i.table === "refund_requests");
    expect(ins).toBeTruthy();
    expect(ins?.values.status).toBe("pending");
    expect(ins?.values.user_id).toBe("user-aaa");
    expect(ins?.values.audit_log_id).toBe("audit-1");
  });

  it("auto-attempts a Stripe refund when the charge is < 24h and the txn id is a PaymentIntent", async () => {
    const created = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    state.auditLogRow = {
      id: "audit-2",
      user_id: "user-aaa",
      amount_usd: 9.99,
      transaction_id: "pi_recent123",
      status: "success",
      created_at: created,
    };
    refundsCreate.mockResolvedValueOnce({
      id: "re_abc",
      amount: 999, // cents
    });
    state.insertResultRow = {
      id: "refund-2",
      user_id: "user-aaa",
      audit_log_id: "audit-2",
      amount_usd: 9.99,
      reason: "duplicate",
      status: "refunded",
      created_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
      refunded_amount_usd: 9.99,
      stripe_refund_id: "re_abc",
      resolution_note: "Auto-refunded via Stripe within 24h window.",
      transaction_id: "pi_recent123",
      user_explanation: null,
    };

    const { POST } = await import("../app/api/refunds/route");
    const res = await POST(
      makeRequest({
        audit_log_id: "audit-2",
        reason: "duplicate",
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(201);
    expect(refundsCreate).toHaveBeenCalledTimes(1);
    const callArg = refundsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.payment_intent).toBe("pi_recent123");
    expect(callArg.reason).toBe("duplicate");

    const ins = state.inserts.find((i) => i.table === "refund_requests");
    expect(ins?.values.status).toBe("refunded");
    expect(ins?.values.stripe_refund_id).toBe("re_abc");
    expect(ins?.values.refunded_amount_usd).toBe(9.99);
  });

  it("returns 404 when the audit_log belongs to another user (ownership check)", async () => {
    state.auditLogRow = {
      id: "audit-3",
      user_id: "user-OTHER",
      amount_usd: 5,
      transaction_id: "pi_x",
      status: "success",
      created_at: new Date().toISOString(),
    };

    const { POST } = await import("../app/api/refunds/route");
    const res = await POST(
      makeRequest({
        audit_log_id: "audit-3",
        reason: "not_authorized",
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(res.status).toBe(404);
    expect(state.inserts).toHaveLength(0);
    expect(refundsCreate).not.toHaveBeenCalled();
  });
});
