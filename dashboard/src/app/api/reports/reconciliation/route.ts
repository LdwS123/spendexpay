/**
 * GET /api/reports/reconciliation?month=YYYY-MM
 *
 * Reconciles two views of the same month:
 *   - `spendex_charged`     = SUM of audit_logs.amount_usd for successful
 *                             transactions in the month, per the user's
 *                             internal Spendex ledger.
 *   - `funding_card_charged`= SUM of Stripe charges against the user's
 *                             Stripe Customer for the month, as reported by
 *                             the Stripe API.
 *
 * In a perfectly healthy account these should match. A non-zero diff means
 * one of: a refund was issued, a pending Stripe charge has not captured
 * yet, or a reconciliation bug we need to investigate.
 *
 * Authorization:
 *   Session-cookie auth via the user's Supabase session. We never accept a
 *   user_id query param so that an authenticated user cannot query other
 *   accounts. The user identity is derived server-side.
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseMonthRange(
  monthStr: string
): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec(monthStr);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start, end };
}

interface ReconciliationTx {
  source: "spendex" | "stripe";
  id: string;
  created_at: string;
  service: string | null;
  amount_usd: number;
  status: string;
  description: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Sum all Stripe charges paid by a given Customer during [start, end).
 * Walks the paginated charges list — Stripe caps each page at 100 but the
 * async iterator transparently fetches subsequent pages.
 */
async function fetchStripeChargesForCustomer(
  stripe: Stripe,
  customerId: string,
  start: Date,
  end: Date
): Promise<{ total_usd: number; transactions: ReconciliationTx[] }> {
  const startSec = Math.floor(start.getTime() / 1000);
  const endSec = Math.floor(end.getTime() / 1000);

  const txs: ReconciliationTx[] = [];
  let total = 0;

  const list = stripe.charges.list({
    customer: customerId,
    created: { gte: startSec, lt: endSec },
    limit: 100,
  });

  for await (const charge of list) {
    const amountCents = charge.amount;
    const refundedCents = charge.amount_refunded ?? 0;
    const netCents = Math.max(0, amountCents - refundedCents);
    const amountUsd = netCents / 100;
    total += amountUsd;
    txs.push({
      source: "stripe",
      id: charge.id,
      created_at: new Date(charge.created * 1000).toISOString(),
      service: null,
      amount_usd: round2(amountUsd),
      status: charge.status,
      description: charge.description ?? null,
    });
  }

  return { total_usd: round2(total), transactions: txs };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const server = await createClient();
  const {
    data: { user },
    error: authError,
  } = await server.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const monthParam = req.nextUrl.searchParams.get("month");
  if (!monthParam) {
    return NextResponse.json(
      { error: "Missing required ?month=YYYY-MM" },
      { status: 400 }
    );
  }
  const range = parseMonthRange(monthParam);
  if (!range) {
    return NextResponse.json(
      { error: "Invalid month — expected YYYY-MM" },
      { status: 400 }
    );
  }

  const admin = getAdminClient();

  const { data: spendexRows, error: spendexErr } = await admin
    .from("audit_logs")
    .select(
      "id, created_at, service, status, amount_usd, description, transaction_id"
    )
    .eq("user_id", user.id)
    .eq("status", "success")
    .gte("created_at", range.start.toISOString())
    .lt("created_at", range.end.toISOString())
    .order("created_at", { ascending: false });

  if (spendexErr) {
    console.error(
      `[reconciliation] audit_logs query error: ${spendexErr.message}`
    );
    return NextResponse.json(
      { error: "Failed to query Spendex ledger" },
      { status: 500 }
    );
  }

  type Row = {
    id: string;
    created_at: string;
    service: string | null;
    status: string;
    amount_usd: number | null;
    description: string | null;
    transaction_id: string | null;
  };
  const ledgerTxs: ReconciliationTx[] = ((spendexRows ?? []) as Row[]).map(
    (r) => ({
      source: "spendex" as const,
      id: r.id,
      created_at: r.created_at,
      service: r.service,
      amount_usd: round2(
        typeof r.amount_usd === "number" ? r.amount_usd : 0
      ),
      status: r.status,
      description: r.description,
    })
  );
  const spendexCharged = round2(
    ledgerTxs.reduce((acc, t) => acc + t.amount_usd, 0)
  );

  const { data: userRow, error: userRowErr } = await admin
    .from("users")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (userRowErr) {
    console.error(`[reconciliation] users lookup error: ${userRowErr.message}`);
  }

  let stripeCharged = 0;
  let stripeTxs: ReconciliationTx[] = [];
  const stripeCustomerId = userRow?.stripe_customer_id ?? null;

  if (stripeCustomerId) {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error(
        "[reconciliation] STRIPE_SECRET_KEY not set; skipping funding-card view"
      );
    } else {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: "2025-02-24.acacia",
      });
      try {
        const res = await fetchStripeChargesForCustomer(
          stripe,
          stripeCustomerId,
          range.start,
          range.end
        );
        stripeCharged = res.total_usd;
        stripeTxs = res.transactions;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[reconciliation] Stripe charges list failed: ${message}`);
      }
    }
  }

  const diff = round2(spendexCharged - stripeCharged);

  const transactions = [...ledgerTxs, ...stripeTxs].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return NextResponse.json(
    {
      month: monthParam,
      range: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      },
      spendex_charged: spendexCharged,
      funding_card_charged: stripeCharged,
      diff,
      has_funding_source: Boolean(stripeCustomerId),
      transactions,
    },
    { status: 200 }
  );
}
