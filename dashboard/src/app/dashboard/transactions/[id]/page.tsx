import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import type { AuditLog } from "@/app/api/transactions/route";
import RefundRequestPanel from "./RefundRequestPanel";

export const dynamic = "force-dynamic";

// ─── helpers ────────────────────────────────────────────────────────────────

const FAILED_STATUSES = ["payment_failed", "deploy_failed_after_payment"];
const REFUND_ELIGIBLE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatDateFull(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }) +
    " at " +
    d.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  );
}

function formatAmount(usd: number): string {
  return "€" + usd.toFixed(2);
}

// ─── service icon ────────────────────────────────────────────────────────────

function ServiceIcon({ service }: { service: string }) {
  const s = service.toLowerCase();

  if (s === "vercel") {
    return (
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 512 512" aria-hidden="true">
        <path d="M256 48L496 464H16L256 48z" />
      </svg>
    );
  }
  if (s === "modal") {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <path d="M5 8h6M8 5v6" strokeLinecap="round" />
      </svg>
    );
  }
  if (s === "railway") {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (s === "fly" || s === "flyio" || s === "fly.io") {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path d="M3 13L8 3l5 10" strokeLinejoin="round" />
        <path d="M5.5 9h5" strokeLinecap="round" />
      </svg>
    );
  }
  if (s === "render") {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path d="M3 3h10v10H3z" />
        <path d="M6 6l4 4M10 6l-4 4" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <rect x="2" y="4" width="12" height="9" rx="1.5" />
      <path d="M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1" />
    </svg>
  );
}

// ─── status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const failed = FAILED_STATUSES.includes(status);
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">
        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
        Charged
      </span>
    );
  }
  if (failed) {
    const label = status === "payment_failed" ? "Payment failed" : "Deploy failed";
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-700 border border-red-100">
        <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1 rounded-full bg-slate-50 text-slate-500 border border-slate-100">
      <span className="w-2 h-2 rounded-full bg-slate-400 shrink-0" />
      {capitalise(status)}
    </span>
  );
}

// ─── detail row ───────────────────────────────────────────────────────────────

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 py-3.5 border-b border-slate-50 last:border-b-0">
      <dt className="w-44 shrink-0 text-xs font-medium text-slate-400 uppercase tracking-wide pt-0.5">
        {label}
      </dt>
      <dd className="flex-1 text-sm text-[#0a1220] break-all">{children}</dd>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TransactionDetailPage({ params }: PageProps) {
  const { id } = await params;

  // Auth check
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/dashboard/transactions");
  }

  // Fetch the row via admin client (bypasses RLS — we enforce ownership manually)
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch {
    redirect("/dashboard/transactions");
  }

  const { data, error } = await admin
    .from("audit_logs")
    .select(
      "id, created_at, user_id, service, status, amount_usd, description, transaction_id, transaction_type, agent_id, error_message"
    )
    .eq("id", id)
    .single();

  if (error || !data) {
    redirect("/dashboard/transactions");
  }

  const tx = data as AuditLog;

  // Ownership check
  if (tx.user_id !== user.id) {
    redirect("/dashboard/transactions");
  }

  const isFailed = FAILED_STATUSES.includes(tx.status);

  // Refund eligibility: success status, within 30 days, non-zero amount.
  // Wrapped in a defensive check so a missing refund_requests table (e.g.
  // a dashboard pointed at a DB where migration 012 hasn't run) just hides
  // the panel rather than crashing the page.
  let refundEligible = false;
  try {
    const txAgeMs = Date.now() - new Date(tx.created_at).getTime();
    refundEligible =
      tx.status === "success" &&
      txAgeMs < REFUND_ELIGIBLE_WINDOW_MS &&
      typeof tx.amount_usd === "number" &&
      tx.amount_usd > 0;
  } catch {
    refundEligible = false;
  }

  return (
    <main>
      {/* Page header */}
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center gap-4">
        <Link
          href="/dashboard/transactions"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-[#0a1220] transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </Link>

        <div className="h-4 w-px bg-slate-200" />

        <div>
          <h1 className="text-lg font-semibold text-[#0a1220]">Transaction detail</h1>
          <p className="text-xs text-slate-400 mt-0.5 font-mono">{tx.id}</p>
        </div>
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-3xl">
        {/* Summary card */}
        <div className="bg-white rounded-xl border border-slate-100 overflow-hidden mb-6">
          {/* Hero strip */}
          <div className="flex items-center gap-4 px-6 py-5 border-b border-slate-100">
            <div className="w-11 h-11 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-600 shrink-0">
              <ServiceIcon service={tx.service} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="text-base font-semibold text-[#0a1220]">
                  {capitalise(tx.service)}
                </span>
                {tx.transaction_type && (
                  <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 uppercase tracking-wide">
                    {tx.transaction_type.replace(/_/g, "-")}
                  </span>
                )}
                <StatusBadge status={tx.status} />
              </div>
              {tx.description && (
                <p className="text-sm text-slate-400 mt-0.5 truncate">{tx.description}</p>
              )}
            </div>
            <div className="shrink-0 text-right">
              <p
                className={`text-xl sm:text-2xl font-bold tabular-nums ${
                  tx.status === "success" ? "text-[#0a1220]" : "text-slate-300"
                }`}
              >
                {tx.amount_usd != null ? formatAmount(tx.amount_usd) : "—"}
              </p>
            </div>
          </div>

          {/* Detail rows */}
          <dl className="px-6">
            <DetailRow label="Date &amp; time">{formatDateFull(tx.created_at)}</DetailRow>

            <DetailRow label="Service">{capitalise(tx.service)}</DetailRow>

            <DetailRow label="Status">
              <StatusBadge status={tx.status} />
            </DetailRow>

            <DetailRow label="Amount">
              {tx.amount_usd != null ? (
                <span className="font-semibold tabular-nums">
                  {formatAmount(tx.amount_usd)}
                </span>
              ) : (
                <span className="text-slate-400">—</span>
              )}
            </DetailRow>

            {tx.description && (
              <DetailRow label="Description">{tx.description}</DetailRow>
            )}

            {tx.transaction_id && (
              <DetailRow label="Stripe transaction">
                <span className="font-mono text-xs bg-slate-50 border border-slate-100 rounded px-1.5 py-0.5">
                  {tx.transaction_id}
                </span>
              </DetailRow>
            )}

            {tx.agent_id && (
              <DetailRow label="Agent ID">
                <span className="font-mono text-xs text-slate-500">{tx.agent_id}</span>
              </DetailRow>
            )}

            {isFailed && tx.error_message && (
              <DetailRow label="Error">
                <span className="text-red-600">{tx.error_message}</span>
              </DetailRow>
            )}
          </dl>
        </div>

        {/* Refund / dispute panel — client island. Hidden if not eligible
            and there's no existing refund request on file. */}
        <RefundRequestPanel auditLogId={tx.id} eligible={refundEligible} />

        {/* Back link at the bottom */}
        <Link
          href="/dashboard/transactions"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-[#0a1220] transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to transactions
        </Link>
      </div>
    </main>
  );
}
