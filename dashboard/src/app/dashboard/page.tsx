import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import Link from "next/link";
import SpendingChart from "./SpendingChart";
import OverviewLiveStats from "./OverviewLiveStats";
import OnboardingBanner from "./OnboardingBanner";
import SampleTransactionsToggle from "./SampleTransactionsToggle";
import AnomalyBanner from "./AnomalyBanner";
import PainKillerBanner from "./PainKillerBanner";

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

interface OnboardingState {
  hasMcpToken: boolean;
  hasVirtualCard: boolean;
}

async function getOnboardingState(userId: string): Promise<OnboardingState> {
  // Gracefully handle every failure path: missing table, missing column,
  // dev mode with no credentials. We never want this widget to 500 the
  // entire Overview page.
  let client: ReturnType<typeof getAdminClient>;
  try {
    client = getAdminClient();
  } catch {
    return { hasMcpToken: false, hasVirtualCard: false };
  }

  let hasMcpToken = false;
  let hasVirtualCard = false;

  try {
    const { data, error } = await client
      .from("users")
      .select("mcp_token")
      .eq("id", userId)
      .maybeSingle();
    if (!error && data) {
      hasMcpToken = data.mcp_token !== null && data.mcp_token !== undefined;
    }
  } catch (err) {
    console.error("[dashboard] onboarding mcp_token check failed:", err);
  }

  try {
    const { count, error } = await client
      .from("virtual_cards")
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (!error) {
      hasVirtualCard = (count ?? 0) > 0;
    } else if (error.code !== "42P01") {
      // 42P01 = table missing — render as "no card" rather than 500.
      console.error("[dashboard] virtual_cards count error:", error);
    }
  } catch (err) {
    console.error("[dashboard] virtual_cards check failed:", err);
  }

  return { hasMcpToken, hasVirtualCard };
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Layout already redirects if no user, but guard here for type safety
  if (!user) return null;

  const [data, pendingConsents, onboarding] = await Promise.all([
    getSpendingData(user.id),
    getPendingConsentCount(user.id),
    getOnboardingState(user.id),
  ]);

  const currentMonth = new Date().toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });

  return (
    <main className="flex-1 overflow-auto">
      {/* Header */}
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <div className="flex items-center justify-between gap-4">
        <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              {currentMonth}
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0a1220]">
              Agent spending
            </h1>
        </div>
        <Link
          href="/dashboard/wallet"
            className="rounded-lg bg-[#070d18] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#0f1c30]"
        >
            Manage wallet
        </Link>
        </div>
      </header>

      <div className="max-w-6xl px-4 py-7 sm:px-8">
        <AnomalyBanner />
        <OnboardingBanner
          hasFundingSource={onboarding.hasVirtualCard}
          hasMcpToken={onboarding.hasMcpToken}
        />
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
            {/* Pain-killer pitch — visible only while the user has no
                transactions on file. Vanishes after the first charge. */}
            <PainKillerBanner />

            {/* Stat cards — all zeroed */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-7">
              <StatCard label="Spent this month" value="€0.00" sub="No transactions yet" />
              <StatCard label="Transactions" value="0" sub="This month" />
              <StatCard label="Top service" value="—" sub="No data yet" />
            </div>

            <div className="max-w-3xl overflow-hidden rounded-2xl border border-slate-200/70 bg-white">
              <div className="border-b border-slate-100 px-6 py-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  Setup
                </p>
                <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-[#0a1220]">
                  Prepare this workspace for agent payments
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
                  Connect funding, issue an MCP token, and define the limits
                  enforced before card details are revealed.
                </p>
              </div>

              <div className="grid gap-0 md:grid-cols-[1fr_260px]">
                <div className="p-6">
                  <ol className="space-y-5">
                    <OnboardingStep
                      number={1}
                      title="Connect funding"
                      description="Add the payment method used to fund agent purchases."
                      action={{ label: "Open wallet", href: "/dashboard/wallet" }}
                    />
                    <OnboardingStep
                      number={2}
                      title="Create MCP access"
                      description="Generate a token and add Spendex to Cursor, Claude Code, or another MCP client."
                      action={{ label: "Manage MCP tokens", href: "/dashboard/tokens" }}
                    />
                    <OnboardingStep
                      number={3}
                      title="Define limits"
                      description="Set per-transaction caps, monthly budgets, and merchant exclusions."
                      action={{ label: "Review rules", href: "/dashboard/rules" }}
                    />
                    <OnboardingStep
                      number={4}
                      title="Review approvals"
                      description="Pending consent requests appear here when an agent needs a human decision."
                      action={{ label: "Open approvals", href: "/dashboard/consents" }}
                    />
                  </ol>
                </div>

                <div className="border-t border-slate-100 bg-[#070d18] p-6 text-white md:border-l md:border-t-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/35">
                    Install
                  </p>
                  <pre className="mt-4 whitespace-pre-wrap break-all font-mono text-[12px] leading-6 text-white/78">
                    <span className="text-[#00e5b4]">$</span> npx @spendexai/mcp
                  </pre>
                  <div className="mt-5 space-y-2 border-t border-white/8 pt-5 text-xs text-white/45">
                    <p>Auth: MCP token</p>
                    <p>Controls: rules + consent</p>
                    <p>Ledger: audit logs</p>
                  </div>
                </div>
              </div>
            </div>

            {onboarding.hasVirtualCard && (
              <section className="mt-7">
                <div className="mb-3">
                  <h2 className="text-sm font-semibold text-[#0a1220]">
                    Recent activity
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    A preview of how your agent&apos;s spending will appear here.
                  </p>
                </div>
                <SampleTransactionsToggle />
              </section>
            )}
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
                  href="/dashboard/activity"
                  className="text-xs text-[#00e5b4] hover:text-[#00c49a] font-medium transition-colors"
                >
                  View all →
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
                  <div className="divide-y divide-slate-50">
                    {data.recentTransactions.map((tx) => (
                      <Link
                        key={tx.id}
                        href={`/dashboard/transactions/${tx.id}`}
                        aria-label={`Transaction ${serviceName(tx.service)} ${tx.amount_usd !== null ? formatEur(tx.amount_usd) : ""} on ${formatDate(tx.created_at)}, status ${tx.status}`}
                        className="relative flex items-center gap-4 px-5 py-3.5 hover:bg-slate-50/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5b4] focus-visible:ring-inset"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[#0a1220]">
                              {serviceName(tx.service)}
                            </span>
                            <span className="text-[11px] text-slate-400 hidden md:inline">
                              · {formatDate(tx.created_at)}
                            </span>
                          </div>
                          {(tx.description || tx.transaction_type) && (
                            <p className="text-xs text-slate-500 mt-0.5 truncate max-w-md">
                              {tx.description ?? tx.transaction_type}
                            </p>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-semibold text-[#0a1220] tabular-nums">
                            {tx.amount_usd !== null ? formatEur(tx.amount_usd) : "—"}
                          </div>
                          <div className="mt-1">{statusBadge(tx.status)}</div>
                        </div>
                        <svg className="w-4 h-4 text-slate-300 shrink-0" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Quick actions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
              <QuickAction
                title="Add funding source"
                description="Link a card to keep your wallet topped up automatically."
                href="/dashboard/wallet"
                cta="Manage wallet"
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

