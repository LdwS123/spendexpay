import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AuditLog } from "@/app/api/transactions/route";
import TransactionsClient from "../transactions/TransactionsClient";
import OrdersFeed from "./OrdersFeed";

// Computed once per request; passed to the client export button so it
// uses the same window we describe in the UI ("this month").
function getThisMonthRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
  ).toISOString();
  const to = now.toISOString();
  return { from, to };
}

function ExportCsvButton({ from, to }: { from: string; to: string }) {
  const href = `/api/transactions/export?from=${encodeURIComponent(
    from
  )}&to=${encodeURIComponent(to)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 transition-colors"
    >
      <svg
        className="w-3.5 h-3.5"
        fill="none"
        viewBox="0 0 16 16"
        stroke="currentColor"
        strokeWidth={1.6}
        aria-hidden="true"
      >
        <path
          d="M8 2v8m0 0l-3-3m3 3l3-3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M2.5 11v2a1 1 0 001 1h9a1 1 0 001-1v-2" strokeLinecap="round" />
      </svg>
      Export CSV
    </a>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity — merges the legacy /dashboard/transactions and /dashboard/orders
// pages behind one URL with two top-level tabs (Transactions / Orders). The
// tab is driven by ?view=transactions | orders in the URL so it remains
// linkable and the active tab survives a hard refresh.
//
// Status filter (?status=success|failed) is preserved for the Transactions
// tab; the Orders tab does not use it (orders are by definition successful
// product charges).
// ─────────────────────────────────────────────────────────────────────────────

type ActivityView = "transactions" | "orders";

interface PageProps {
  searchParams: Promise<{ status?: string; view?: string }>;
}

function FilterLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
        active
          ? "bg-[#0D0F14] text-white border-[#0D0F14]"
          : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"
      }`}
    >
      {label}
    </Link>
  );
}

export default async function ActivityPage({ searchParams }: PageProps) {
  const { status: rawStatus, view: rawView } = await searchParams;

  const view: ActivityView = rawView === "orders" ? "orders" : "transactions";

  const statusFilter: "success" | "failed" | undefined =
    rawStatus === "success"
      ? "success"
      : rawStatus === "failed"
        ? "failed"
        : undefined;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Pre-fetch transactions for the Transactions tab so the first paint is
  // not blank. The Orders tab does its own server fetch via <OrdersFeed/>.
  let transactions: AuditLog[] = [];
  let total = 0;

  if (view === "transactions") {
    const FAILED_STATUSES_LIST = [
      "payment_failed",
      "deploy_failed_after_payment",
    ];

    let query = supabase
      .from("audit_logs")
      .select(
        "id, created_at, user_id, service, status, amount_usd, description, transaction_id, transaction_type, agent_id, error_message",
        { count: "exact" }
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (statusFilter === "success") {
      query = query.eq("status", "success");
    } else if (statusFilter === "failed") {
      query = query.in("status", FAILED_STATUSES_LIST);
    }

    const { data, count, error } = await query;
    if (error) {
      console.error("[activity/page] Supabase query error:", error);
    } else {
      transactions = (data ?? []) as AuditLog[];
      total = count ?? 0;
    }
  }

  const STATUS_FILTERS: { label: string; value: string | undefined; href: string }[] = [
    { label: "All", value: undefined, href: "/dashboard/activity" },
    {
      label: "Charged",
      value: "success",
      href: "/dashboard/activity?status=success",
    },
    {
      label: "Failed",
      value: "failed",
      href: "/dashboard/activity?status=failed",
    },
  ];

  return (
    <main>
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Ledger
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0D0F14]">
              Activity
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Every charge attempt and every completed purchase, in one feed.
            </p>
          </div>
          {view === "transactions" && total > 0 && (
            <span className="text-xs text-slate-500 shrink-0">
              {total} {total === 1 ? "transaction" : "transactions"}
              {statusFilter ? ` · ${statusFilter}` : ""}
            </span>
          )}
        </div>
      </header>

      <div className="max-w-6xl px-4 py-7 sm:px-8">
        {/* ── View tabs ── */}
        <div
          role="tablist"
          aria-label="Activity view"
          className="mb-5 inline-flex rounded-lg border border-slate-200 bg-white p-1"
        >
          <TabLink
            href="/dashboard/activity"
            label="Transactions"
            active={view === "transactions"}
          />
          <TabLink
            href="/dashboard/activity?view=orders"
            label="Orders"
            active={view === "orders"}
          />
        </div>

        {view === "transactions" ? (
          <>
            <div className="flex items-center gap-2 sm:gap-3 mb-5 flex-wrap">
              {STATUS_FILTERS.map((f) => (
                <FilterLink
                  key={f.label}
                  href={f.href}
                  label={f.label}
                  active={f.value === statusFilter}
                />
              ))}
              <div className="ml-auto">
                {(() => {
                  const { from, to } = getThisMonthRange();
                  return <ExportCsvButton from={from} to={to} />;
                })()}
              </div>
            </div>

            <TransactionsClient
              initialTransactions={transactions}
              userId={user.id}
              statusFilter={statusFilter}
            />
          </>
        ) : (
          <OrdersFeed userId={user.id} />
        )}
      </div>
    </main>
  );
}

function TabLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
        active
          ? "bg-[#0D0F14] text-white"
          : "text-slate-500 hover:text-[#0D0F14]"
      }`}
    >
      {label}
    </Link>
  );
}
