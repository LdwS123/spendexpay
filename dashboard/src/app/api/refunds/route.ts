/**
 * /api/refunds — user-initiated refund / dispute flow.
 *
 *  POST  Create a refund_request for one of the caller's audit_logs rows.
 *        If the underlying charge is younger than 24h AND looks like a Stripe
 *        PaymentIntent (transaction_id starts with "pi_"), we auto-attempt the
 *        refund through Stripe and persist status='refunded' on success.
 *        Otherwise the row is saved as 'pending' for async (human) review.
 *
 *  GET   List the caller's refund_requests, newest first. The response
 *        separates active (pending/approved) from history (refunded/declined/
 *        partial_refund) so the UI can render two sections without re-sorting.
 *
 * Ownership is enforced server-side: audit_log_id is resolved against
 * audit_logs.user_id and rejected with 404 if it doesn't belong to the
 * authenticated user — we deliberately return 404 (not 403) to avoid
 * leaking which IDs exist in the system.
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const VALID_REASONS = [
  "not_authorized",
  "wrong_amount",
  "duplicate",
  "not_received",
  "cancelled",
  "other",
] as const;
type RefundReason = (typeof VALID_REASONS)[number];

const AUTO_REFUND_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RefundRequest {
  id: string;
  user_id: string;
  audit_log_id: string | null;
  transaction_id: string | null;
  amount_usd: number;
  reason: RefundReason;
  user_explanation: string | null;
  status: "pending" | "approved" | "declined" | "refunded" | "partial_refund";
  refunded_amount_usd: number | null;
  stripe_refund_id: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface CreateBody {
  audit_log_id?: unknown;
  reason?: unknown;
  user_explanation?: unknown;
}

function isRefundReason(value: unknown): value is RefundReason {
  return (
    typeof value === "string" &&
    (VALID_REASONS as readonly string[]).includes(value)
  );
}

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

// ─── POST ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  const userId = user.id;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const auditLogId = body.audit_log_id;
  const reason = body.reason;
  const userExplanation = body.user_explanation;

  if (typeof auditLogId !== "string" || auditLogId.length === 0) {
    return NextResponse.json(
      { error: "audit_log_id is required" },
      { status: 400 }
    );
  }
  if (!isRefundReason(reason)) {
    return NextResponse.json(
      { error: "reason must be one of: " + VALID_REASONS.join(", ") },
      { status: 400 }
    );
  }
  if (
    userExplanation !== undefined &&
    userExplanation !== null &&
    typeof userExplanation !== "string"
  ) {
    return NextResponse.json(
      { error: "user_explanation must be a string" },
      { status: 400 }
    );
  }
  if (typeof userExplanation === "string" && userExplanation.length > 2000) {
    return NextResponse.json(
      { error: "user_explanation must be 2000 characters or fewer" },
      { status: 400 }
    );
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/refunds] admin client unavailable:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  // Resolve the audit log row and verify ownership in a single query. We
  // deliberately return 404 (not 403) if the row exists but belongs to
  // someone else — see file header.
  const { data: auditRow, error: auditErr } = await admin
    .from("audit_logs")
    .select("id, user_id, amount_usd, transaction_id, status, created_at")
    .eq("id", auditLogId)
    .maybeSingle();

  if (auditErr) {
    console.error("[api/refunds] audit_log lookup failed:", auditErr);
    return NextResponse.json(
      { error: "Failed to look up transaction" },
      { status: 500 }
    );
  }
  if (!auditRow || auditRow.user_id !== userId) {
    return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  }

  if (auditRow.status !== "success") {
    return NextResponse.json(
      { error: "Only successful charges are refundable" },
      { status: 400 }
    );
  }

  const amountUsd =
    typeof auditRow.amount_usd === "number" ? auditRow.amount_usd : 0;
  if (amountUsd <= 0) {
    return NextResponse.json(
      { error: "This transaction has no refundable amount" },
      { status: 400 }
    );
  }

  // Block duplicate active refund requests for the same audit_log.
  const { data: existing, error: existingErr } = await admin
    .from("refund_requests")
    .select("id, status")
    .eq("audit_log_id", auditLogId)
    .in("status", ["pending", "approved", "refunded", "partial_refund"])
    .maybeSingle();
  if (existingErr) {
    console.error("[api/refunds] dup-check failed:", existingErr);
    return NextResponse.json(
      { error: "Failed to check existing refunds" },
      { status: 500 }
    );
  }
  if (existing) {
    return NextResponse.json(
      {
        error: "A refund request already exists for this transaction",
        refund_request_id: existing.id,
      },
      { status: 409 }
    );
  }

  // Decide whether to auto-process via Stripe. We only attempt this for
  // Stripe PaymentIntent IDs ("pi_…") on charges younger than 24h.
  const createdAtMs = new Date(auditRow.created_at).getTime();
  const ageMs = Date.now() - createdAtMs;
  const transactionId: string | null = auditRow.transaction_id ?? null;
  const eligibleForAuto =
    ageMs < AUTO_REFUND_WINDOW_MS &&
    typeof transactionId === "string" &&
    transactionId.startsWith("pi_");

  let status: RefundRequest["status"] = "pending";
  let stripeRefundId: string | null = null;
  let refundedAmountUsd: number | null = null;
  let resolutionNote: string | null = null;
  let resolvedAt: string | null = null;

  if (eligibleForAuto && transactionId) {
    try {
      const stripe = getStripe();
      const refund = await stripe.refunds.create({
        payment_intent: transactionId,
        reason:
          reason === "duplicate"
            ? "duplicate"
            : reason === "not_authorized"
              ? "fraudulent"
              : "requested_by_customer",
        metadata: {
          spendex_user_id: userId,
          spendex_audit_log_id: auditLogId,
          spendex_reason: reason,
        },
      });
      stripeRefundId = refund.id;
      // Stripe returns amount in the smallest currency unit (cents for USD).
      refundedAmountUsd =
        typeof refund.amount === "number" ? refund.amount / 100 : amountUsd;
      status =
        refundedAmountUsd >= amountUsd ? "refunded" : "partial_refund";
      resolutionNote = "Auto-refunded via Stripe within 24h window.";
      resolvedAt = new Date().toISOString();
    } catch (err) {
      // Auto-refund failed: fall back to pending so a human can resolve.
      console.error("[api/refunds] Stripe auto-refund failed:", err);
      status = "pending";
      resolutionNote =
        "Auto-refund attempt failed; escalated to manual review.";
    }
  }

  const insertRow: {
    user_id: string;
    audit_log_id: string;
    transaction_id: string | null;
    amount_usd: number;
    reason: RefundReason;
    user_explanation: string | null;
    status: RefundRequest["status"];
    stripe_refund_id: string | null;
    refunded_amount_usd: number | null;
    resolution_note: string | null;
    resolved_at: string | null;
  } = {
    user_id: userId,
    audit_log_id: auditLogId,
    transaction_id: transactionId,
    amount_usd: amountUsd,
    reason,
    user_explanation:
      typeof userExplanation === "string" && userExplanation.trim().length > 0
        ? userExplanation.trim()
        : null,
    status,
    stripe_refund_id: stripeRefundId,
    refunded_amount_usd: refundedAmountUsd,
    resolution_note: resolutionNote,
    resolved_at: resolvedAt,
  };

  const { data: inserted, error: insertErr } = await admin
    .from("refund_requests")
    .insert(insertRow)
    .select("*")
    .single();

  if (insertErr || !inserted) {
    console.error("[api/refunds] insert failed:", insertErr);
    return NextResponse.json(
      { error: "Failed to record refund request" },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { refund_request: inserted as RefundRequest },
    { status: 201 }
  );
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/refunds] admin client unavailable:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  const { data, error } = await admin
    .from("refund_requests")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[api/refunds] list query failed:", error);
    return NextResponse.json(
      { error: "Failed to fetch refund requests" },
      { status: 500 }
    );
  }

  const rows = (data ?? []) as RefundRequest[];
  const active: RefundRequest[] = [];
  const history: RefundRequest[] = [];
  for (const row of rows) {
    if (row.status === "pending" || row.status === "approved") {
      active.push(row);
    } else {
      history.push(row);
    }
  }

  return NextResponse.json({ active, history }, { status: 200 });
}
