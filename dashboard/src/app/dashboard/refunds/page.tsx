import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import type { RefundRequest } from "@/app/api/refunds/route";

export const dynamic = "force-dynamic";

// ─── helpers ────────────────────────────────────────────────────────────────

const REASON_LABEL: Record<string, string> = {
  not_authorized: "Not authorized",
  wrong_amount: "Wrong amount",
  duplicate: "Duplicate charge",
  not_received: "Service not received",
  cancelled: "Cancelled subscription",
  other: "Other",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatAmount(usd: number): string {
  return "€" + usd.toFixed(2);
}

function badgeClasses(status: RefundRequest["status"]): string {
  switch (status) {
    case "refunded":
    case "partial_refund":
      return "bg-emerald-50 text-emerald-700 border-emerald-100";
    case "approved":
      return "bg-sky-50 text-sky-700 border-sky-100";
    case "pending":
      return "bg-amber-50 text-amber-700 border-amber-100";
    case "declined":
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

function statusLabel(status: RefundRequest["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "refunded":
      return "Refunded";
    case "partial_refund":
      return "Partial refund";
    case "declined":
      return "Declined";
  }
}

// ─── row ────────────────────────────────────────────────────────────────────

function RefundRow({ r }: { r: RefundRequest }) {
  const amount =
    r.status === "refunded" || r.status === "partial_refund"
      ? r.refunded_amount_usd ?? r.amount_usd
      : r.amount_usd;

  return (
    <li className="bg-white border border-slate-100 rounded-xl px-5 py-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[#0D0F14]">
            {REASON_LABEL[r.reason] ?? r.reason}
          </span>
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${badgeClasses(
              r.status
            )}`}
          >
            {statusLabel(r.status)}
          </span>
        </div>
        <p className="text-xs text-slate-400 mt-0.5">
          Requested {formatDate(r.created_at)}
          {r.resolved_at && ` · Resolved ${formatDate(r.resolved_at)}`}
        </p>
        {r.user_explanation && (
          <p className="text-xs text-slate-500 mt-1.5 line-clamp-2">
            “{r.user_explanation}”
          </p>
        )}
        {r.resolution_note && (
          <p className="text-xs text-slate-500 mt-1.5 italic">
            {r.resolution_note}
          </p>
        )}
      </div>

      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums text-[#0D0F14]">
          {formatAmount(amount)}
        </p>
        {r.audit_log_id && (
          <Link
            href={`/dashboard/transactions/${r.audit_log_id}`}
            className="text-[11px] text-slate-400 hover:text-[#0D0F14] transition-colors"
          >
            View transaction →
          </Link>
        )}
      </div>
    </li>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

export default async function RefundsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch {
    return (
      <main className="px-4 sm:px-8 py-8">
        <h1 className="text-lg font-semibold text-[#0D0F14]">Refunds</h1>
        <p className="text-sm text-slate-500 mt-2">
          Database client unavailable. Please try again later.
        </p>
      </main>
    );
  }

  // Defensive: if migration 012 hasn't run, render an empty state rather
  // than crashing.
  let rows: RefundRequest[] = [];
  try {
    const { data, error } = await admin
      .from("refund_requests")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200);
    if (!error && data) {
      rows = data as RefundRequest[];
    }
  } catch (err) {
    console.error("[dashboard/refunds] query failed:", err);
    rows = [];
  }

  const pending = rows.filter(
    (r) => r.status === "pending" || r.status === "approved"
  );
  const resolved = rows.filter(
    (r) =>
      r.status === "refunded" ||
      r.status === "partial_refund" ||
      r.status === "declined"
  );

  // "Total refunded this year" — sum of refunded_amount_usd for rows whose
  // resolved_at falls in the current calendar year and status is refunded
  // or partial_refund.
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  const totalRefundedThisYear = rows
    .filter(
      (r) =>
        (r.status === "refunded" || r.status === "partial_refund") &&
        r.resolved_at !== null &&
        new Date(r.resolved_at).getTime() >= yearStart
    )
    .reduce(
      (sum, r) => sum + (r.refunded_amount_usd ?? r.amount_usd ?? 0),
      0
    );

  return (
    <main>
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-5">
        <h1 className="text-lg font-semibold text-[#0D0F14]">Refunds</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Disputed charges and their resolution status.
        </p>
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-3xl space-y-7">
        {/* Stat card */}
        <div className="bg-white border border-slate-100 rounded-xl px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
              Total refunded this year
            </p>
            <p className="text-2xl font-bold text-[#0D0F14] tabular-nums mt-1">
              {formatAmount(totalRefundedThisYear)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400">
              {resolved.length} resolved · {pending.length} pending
            </p>
          </div>
        </div>

        {/* Pending */}
        <section>
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3">
            Pending ({pending.length})
          </h2>
          {pending.length === 0 ? (
            <div className="bg-white border border-dashed border-slate-200 rounded-xl px-5 py-8 text-center">
              <p className="text-sm text-slate-500">No pending refunds.</p>
              <p className="text-xs text-slate-400 mt-1">
                Request one from any transaction&apos;s detail page.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {pending.map((r) => (
                <RefundRow key={r.id} r={r} />
              ))}
            </ul>
          )}
        </section>

        {/* Resolved */}
        <section>
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3">
            Resolved ({resolved.length})
          </h2>
          {resolved.length === 0 ? (
            <div className="bg-white border border-dashed border-slate-200 rounded-xl px-5 py-8 text-center">
              <p className="text-sm text-slate-500">No resolved refunds yet.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {resolved.map((r) => (
                <RefundRow key={r.id} r={r} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
