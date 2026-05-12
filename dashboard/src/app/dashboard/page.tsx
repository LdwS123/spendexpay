import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import Link from "next/link";
import SpendingChart from "./SpendingChart";
import OverviewLiveStats from "./OverviewLiveStats";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuditLogRow {
  id: string;
  created_at: string;
  service: string;
  status: string;
  amount_usd: number | null;
  description: string | null;
  transaction_type: string | null;
}

interface DailySpend {
  date: string;
  amount: number;
}

interface SpendingData {
  monthTotalUsd: number;
  monthTransactionCount: number;
  topService: string | null;
  isEmpty: boolean;
  recentTransactions: AuditLogRow[];
  dailySpend: DailySpend[];
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function getSpendingData(userId: string): Promise<SpendingData> {
  let client: ReturnType<typeof getAdminClient>;
  try {
    client = getAdminClient();
  } catch {
    // In dev mode without real Supabase credentials, return empty state
    return {
      monthTotalUsd: 0,
      monthTransactionCount: 0,
      topService: null,
      isEmpty: true,
      recentTransactions: [],
      dailySpend: [],
    };
  }

  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString();

  const thirtyDaysAgo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29)
  ).toISOString();

  // Fetch this month's successful rows for stats
  const { data: monthRows, error: monthError } = await client
    .from("audit_logs")
    .select("service, status, amount_usd")
    .eq("user_id", userId)
    .eq("status", "success")
    .gte("created_at", monthStart);

  if (monthError) {
    console.error("[dashboard] Month query error:", monthError);
  }

  // Fetch last 30 days of successful transactions for the spending chart
  const { data: chartRows, error: chartError } = await client
    .from("audit_logs")
    .select("created_at, amount_usd")
    .eq("user_id", userId)
    .eq("status", "success")
    .gt("amount_usd", 0)
    .gte("created_at", thirtyDaysAgo);

  if (chartError) {
    console.error("[dashboard] Chart query error:", chartError);
  }

  // Fetch last 5 transactions (any status) for the recent activity table
  const { data: recentRows, error: recentError } = await client
    .from("audit_logs")
    .select("id, created_at, service, status, amount_usd, description, transaction_type")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);

  if (recentError) {
    console.error("[dashboard] Recent transactions query error:", recentError);
  }

  // Check whether user has any transactions at all
  const { count: totalCount } = await client
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  const rows = (monthRows ?? []) as { service: string; status: string; amount_usd: number | null }[];

  let monthTotalUsd = 0;
  const byService: Record<string, number> = {};

  for (const row of rows) {
    const amount = row.amount_usd ?? 0;
    monthTotalUsd += amount;
    if (row.service) {
      byService[row.service] = (byService[row.service] ?? 0) + amount;
    }
  }

  monthTotalUsd = Math.round(monthTotalUsd * 100) / 100;

  const topService =
    Object.entries(byService).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Build 30-day array with 0 for days without transactions
  const dailyMap: Record<string, number> = {};
  for (const row of (chartRows ?? []) as { created_at: string; amount_usd: number }[]) {
    const day = row.created_at.slice(0, 10);
    dailyMap[day] = (dailyMap[day] ?? 0) + row.amount_usd;
  }

  const dailySpend: DailySpend[] = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29 + i)
    );
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    return { date: label, amount: Math.round((dailyMap[key] ?? 0) * 100) / 100 };
  });

  return {
    monthTotalUsd,
    monthTransactionCount: rows.length,
    topService,
    isEmpty: (totalCount ?? 0) === 0,
    recentTransactions: (recentRows ?? []) as AuditLogRow[],
    dailySpend,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEur(usd: number): string {
  // Display as EUR (1:1 approximation; swap for real FX rate when available)
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(usd);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function statusBadge(status: string) {
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
        Paid
      </span>
    );
  }
  if (status === "deploy_failed_after_payment") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-100 rounded-full px-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
        Partial
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-red-700 bg-red-50 border border-red-100 rounded-full px-2 py-0.5">
      <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" />
      Failed
    </span>
  );
}

function serviceName(raw: string): string {
  const map: Record<string, string> = {
    vercel: "Vercel",
    flyio: "Fly.io",
    railway: "Railway",
    render: "Render",
    modal: "Modal GPU",
    netlify: "Netlify",
  };
  return map[raw.toLowerCase()] ?? raw;
}

// ── Page ──────────────────────────────────────────────────────────────────────

async function getPendingConsentCount(userId: string): Promise<number> {
  let client: ReturnType<typeof getAdminClient>;
  try {
    client = getAdminClient();
  } catch {
    return 0;
  }

  try {
    const nowIso = new Date().toISOString();
    const { count, error } = await client
      .from("consent_requests")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "pending")
      .gt("expires_at", nowIso);

    if (error) {
      // 42P01 = table missing — render no banner instead of 500.
      if (error.code === "42P01") return 0;
      console.error("[dashboard] consent_requests count error:", error);
      return 0;
    }
    return count ?? 0;
  } catch (err) {
    console.error("[dashboard] consent_requests unexpected error:", err);
    return 0;
  }
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Layout already redirects if no user, but guard here for type safety
  if (!user) return null;

  const [data, pendingConsents] = await Promise.all([
    getSpendingData(user.id),
    getPendingConsentCount(user.id),
  ]);

  const currentMonth = new Date().toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });

  return (
    <main className="flex-1 overflow-auto">
      {/* Header */}
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[#0a1220]">Overview</h1>
          <p className="text-xs text-slate-400 mt-0.5">{currentMonth}</p>
        </div>
        <Link
          href="/dashboard/payments"
          className="bg-[#00e5b4] hover:bg-[#00c49a] text-[#070d18] font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
        >
          Add funding source
        </Link>
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-5xl">
        {pendingConsents > 0 && (
          <Link
            href="/dashboard/consents"
            className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-3 hover:border-amber-200 hover:bg-amber-50 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 16 16"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <circle cx="8" cy="8" r="6.5" />
                  <path d="M8 5v3.5M8 11h.01" strokeLinecap="round" />
                </svg>
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-amber-900">
                  You have {pendingConsents} pending consent request
                  {pendingConsents === 1 ? "" : "s"}
                </p>
                <p className="text-[11px] text-amber-700/80 mt-0.5">
                  Your agent is waiting on your decision.
                </p>
              </div>
            </div>
            <span className="text-xs font-semibold text-amber-800 shrink-0">
              Review →
            </span>
          </Link>
        )}
        {data.isEmpty ? (
          // ── Onboarding / Get Started ─────────────────────────────────────
          <>
            {/* Stat cards — all zeroed */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-7">
              <StatCard label="Spent this month" value="€0.00" sub="No transactions yet" />
              <StatCard label="Transactions" value="0" sub="This month" />
              <StatCard label="Top service" value="—" sub="No data yet" />
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 p-8 max-w-xl">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-9 h-9 rounded-xl bg-[#00e5b4]/10 flex items-center justify-center shrink-0">
                  <RocketIcon className="w-4 h-4 text-[#00c49a]" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-[#0a1220]">Get started with Spendex Pay</p>
                  <p className="text-xs text-slate-400">
                    Four steps to give your agent its own wallet.
                  </p>
                </div>
              </div>

              <ol className="space-y-5">
                <OnboardingStep
                  number={1}
                  title="Add a funding source"
                  description="Connect a card to fund your wallet."
                  action={{ label: "Add funding source", href: "/dashboard/payments" }}
                />
                <OnboardingStep
                  number={2}
                  title="Install the wallet in your agent"
                  description="Add Spendex MCP to Claude Code, Cursor, or your agent of choice."
                  action={{ label: "View install docs", href: "/docs#install" }}
                />
                <OnboardingStep
                  number={3}
                  title="Set your rules"
                  description="Per-transaction cap, monthly budget, merchant whitelist."
                  action={{ label: "Set rules", href: "/dashboard/rules" }}
                />
                <OnboardingStep
                  number={4}
                  title="Let Spendex sign up for you"
                  description="Allow auto-signup on services your agent needs. You can disable this anytime in Rules."
                  action={{ label: "Configure auto-signup", href: "/dashboard/rules" }}
                />
              </ol>

              {/* Install snippet */}
              <div className="mt-6 relative overflow-hidden rounded-xl bg-gradient-to-br from-[#0e1a2d] via-[#0a1322] to-[#070d18] p-5">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full bg-[#00e5b4]/20 blur-3xl"
                />
                <div className="relative flex items-center justify-between">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/40">
                    Install
                  </p>
                  <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[#00e5b4]/80">
                    Claude Code
                  </p>
                </div>
                <pre className="relative mt-3 font-mono text-[13px] leading-relaxed text-white whitespace-pre-wrap break-all">
                  <span className="text-[#00e5b4]">$</span> claude mcp add spendex
                </pre>
                <p className="relative mt-3 text-[11px] text-white/40 leading-relaxed">
                  One command. Spendex shows up as a tool your agent can call —
                  it spends from the wallet, inside your rules.
                </p>
              </div>
            </div>
          </>
        ) : (
          // ── Real data view ──────────────────────────────────────────────
          <>
            {/* Stat cards — live via Supabase Realtime */}
            <OverviewLiveStats
              userId={user.id}
              initialMonthTotalUsd={data.monthTotalUsd}
              initialMonthTransactionCount={data.monthTransactionCount}
              initialTopService={data.topService}
              currentMonth={currentMonth}
            />

            {/* Spending chart */}
            <div className="mb-7">
              <SpendingChart data={data.dailySpend} />
            </div>

            {/* Recent transactions */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-[#0a1220]">Recent transactions</h2>
                  <p className="text-xs text-slate-400 mt-0.5">Last 5 charge attempts.</p>
                </div>
                <Link
                  href="/dashboard/transactions"
                  className="text-xs text-[#00e5b4] hover:text-[#00c49a] font-medium transition-colors"
                >
                  View all
                </Link>
              </div>

              <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
                {data.recentTransactions.length === 0 ? (
                  <EmptyState
                    icon={<ReceiptIcon className="w-4 h-4 text-slate-300" />}
                    heading="No transactions yet"
                    body="Charges appear here the first time your agent calls a Spendex Pay tool."
                  />
                ) : (
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[420px]">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-5 py-3">
                          Service
                        </th>
                        <th className="text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-4 py-3 hidden sm:table-cell">
                          Description
                        </th>
                        <th className="text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-4 py-3 hidden md:table-cell">
                          Date
                        </th>
                        <th className="text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-4 py-3">
                          Amount
                        </th>
                        <th className="text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-5 py-3">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {data.recentTransactions.map((tx) => (
                        <tr key={tx.id} className="hover:bg-slate-50/60 transition-colors">
                          <td className="px-5 py-3.5 font-medium text-[#0a1220]">
                            {serviceName(tx.service)}
                          </td>
                          <td className="px-4 py-3.5 text-slate-500 text-xs truncate max-w-[180px] hidden sm:table-cell">
                            {tx.description ?? tx.transaction_type ?? "—"}
                          </td>
                          <td className="px-4 py-3.5 text-slate-400 text-xs hidden md:table-cell">
                            {formatDate(tx.created_at)}
                          </td>
                          <td className="px-4 py-3.5 text-right font-semibold text-[#0a1220]">
                            {tx.amount_usd !== null ? formatEur(tx.amount_usd) : "—"}
                          </td>
                          <td className="px-5 py-3.5 text-right">{statusBadge(tx.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            </section>

            {/* Quick actions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
              <QuickAction
                title="Add funding source"
                description="Link a card to keep your wallet topped up automatically."
                href="/dashboard/payments"
                cta="Manage funding"
              />
              <QuickAction
                title="Generate MCP token"
                description="Create a token to connect your coding agent."
                href="/dashboard/tokens"
                cta="Manage tokens"
              />
            </div>
          </>
        )}
      </div>
    </main>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-5">
      <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wide mb-3">
        {label}
      </p>
      <p className="text-xl sm:text-2xl font-bold text-[#0a1220] tracking-tight">{value}</p>
      <p className="text-[11px] text-slate-400 mt-1">{sub}</p>
    </div>
  );
}

function OnboardingStep({
  number,
  title,
  description,
  action,
}: {
  number: number;
  title: string;
  description: React.ReactNode;
  action?: { label: string; href: string };
}) {
  return (
    <li className="flex gap-4">
      <div className="shrink-0 w-6 h-6 rounded-full bg-[#070d18] text-[#00e5b4] text-[11px] font-bold flex items-center justify-center mt-0.5">
        {number}
      </div>
      <div className="flex-1">
        <p className="text-sm font-semibold text-[#0a1220]">{title}</p>
        <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{description}</p>
        {action && (
          <Link
            href={action.href}
            className="inline-block mt-2 text-xs font-semibold text-[#00c49a] hover:text-[#00a882] transition-colors"
          >
            {action.label} →
          </Link>
        )}
      </div>
    </li>
  );
}

function QuickAction({
  title,
  description,
  href,
  cta,
}: {
  title: string;
  description: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-5 flex flex-col gap-3">
      <div>
        <p className="text-sm font-semibold text-[#0a1220]">{title}</p>
        <p className="text-xs text-slate-400 mt-0.5">{description}</p>
      </div>
      <Link
        href={href}
        className="self-start bg-[#070d18] hover:bg-[#0f1c30] text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
      >
        {cta}
      </Link>
    </div>
  );
}

function EmptyState({
  icon,
  heading,
  body,
}: {
  icon: React.ReactNode;
  heading: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
      <div className="w-9 h-9 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center mb-3">
        {icon}
      </div>
      <p className="text-sm font-medium text-slate-600">{heading}</p>
      <p className="text-xs text-slate-400 mt-1 max-w-xs leading-relaxed">{body}</p>
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function ReceiptIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 16 16"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path d="M3 2h10v12l-2-1.5-2 1.5-2-1.5L5 14 3 14V2z" strokeLinejoin="round" />
      <line x1="5.5" y1="6" x2="10.5" y2="6" />
      <line x1="5.5" y1="9" x2="8.5" y2="9" />
    </svg>
  );
}

function RocketIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 16 16"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        d="M8 2C8 2 4.5 4 4 8c-.25 2 .5 3.5 1.5 4.5M8 2c0 0 3.5 2 4 6 .25 2-.5 3.5-1.5 4.5M8 2v10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="12.5" r="1" />
    </svg>
  );
}
