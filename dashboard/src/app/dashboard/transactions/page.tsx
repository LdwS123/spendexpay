import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { AuditLog } from "@/app/api/transactions/route";
import TransactionsClient from "./TransactionsClient";

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
          ? "bg-[#0a1220] text-white border-[#0a1220]"
          : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"
      }`}
    >
      {label}
    </Link>
  );
}

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const { status: rawStatus } = await searchParams;

  const statusFilter: "success" | "failed" | undefined =
    rawStatus === "success" ? "success" : rawStatus === "failed" ? "failed" : undefined;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let transactions: AuditLog[] = [];
  let total = 0;

  if (user) {
    const FAILED_STATUSES_LIST = ["payment_failed", "deploy_failed_after_payment"];

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
      console.error("[transactions/page] Supabase query error:", error);
    } else {
      transactions = (data ?? []) as AuditLog[];
      total = count ?? 0;
    }
  }

  const FILTERS: { label: string; value: string | undefined; href: string }[] = [
    { label: "All", value: undefined, href: "/dashboard/transactions" },
    { label: "Charged", value: "success", href: "/dashboard/transactions?status=success" },
    { label: "Failed", value: "failed", href: "/dashboard/transactions?status=failed" },
  ];

  return (
    <main>
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[#0a1220]">Transactions</h1>
          <p className="text-xs text-slate-400 mt-0.5">Full history of every charge attempt.</p>
        </div>
        {total > 0 && (
          <span className="text-xs text-slate-400">
            {total} {total === 1 ? "transaction" : "transactions"}
            {statusFilter ? ` · ${statusFilter}` : ""}
          </span>
        )}
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-5xl">
        <div className="flex items-center gap-3 mb-5">
          {FILTERS.map((f) => (
            <FilterLink
              key={f.label}
              href={f.href}
              label={f.label}
              active={f.value === statusFilter}
            />
          ))}
          <div className="ml-auto">
            <button
              type="button"
              className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
              disabled
              title="Export coming soon"
            >
              Export CSV
            </button>
          </div>
        </div>

        {user ? (
          <TransactionsClient
            initialTransactions={transactions}
            userId={user.id}
            statusFilter={statusFilter}
          />
        ) : (
          <div className="bg-white rounded-xl border border-slate-100 px-6 py-10 text-center">
            <p className="text-sm text-slate-500">Sign in to view your transactions.</p>
          </div>
        )}
      </div>
    </main>
  );
}
