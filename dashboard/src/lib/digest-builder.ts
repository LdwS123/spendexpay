/**
 * Weekly digest builder.
 *
 * Reads audit_logs for a given week window [weekStart, weekStart + 7d) and
 * computes aggregate stats: total spent, transaction count, top 3 services,
 * largest single charge, declines, success rate, and top agents. We also
 * compute week-over-week deltas vs the prior 7d window for spend and count
 * so the email can render "+12% vs last week" badges.
 *
 * This module is pure data — it never sends email. The API route layered on
 * top wires it to the Resend helper. Keeping them separate makes the
 * aggregation testable in isolation without mocking the email client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditLogRow {
  id: string;
  created_at: string;
  user_id: string;
  service: string | null;
  status: string | null;
  amount_usd: number | null;
  description: string | null;
  transaction_id: string | null;
  transaction_type: string | null;
  agent_id: string | null;
}

export interface ServiceBreakdown {
  service: string;
  total_spent_usd: number;
  transaction_count: number;
}

export interface AgentBreakdown {
  agent_id: string;
  transaction_count: number;
  total_spent_usd: number;
}

export interface RecentTransaction {
  id: string;
  created_at: string;
  service: string;
  amount_usd: number;
  status: string;
  description: string | null;
}

export interface DigestData {
  user_id: string;
  week_start: string; // ISO
  week_end: string; // ISO
  total_spent_usd: number;
  transaction_count: number;
  top_3_services: ServiceBreakdown[];
  largest_charge: RecentTransaction | null;
  declined_count: number;
  success_rate_pct: number; // 0..100
  top_agents: AgentBreakdown[];
  recent_transactions: RecentTransaction[]; // top 5 most recent success
  vs_last_week: {
    spent_diff_pct: number | null; // null when prior week has 0 spend
    count_diff_pct: number | null; // null when prior week has 0 tx
  };
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const SUCCESS_STATUS = new Set(["success", "succeeded", "approved", "captured"]);
const DECLINED_STATUS = new Set([
  "payment_failed",
  "deploy_failed_after_payment",
  "declined",
  "failed",
]);

function isSuccess(status: string | null | undefined): boolean {
  return typeof status === "string" && SUCCESS_STATUS.has(status.toLowerCase());
}

function isDeclined(status: string | null | undefined): boolean {
  return typeof status === "string" && DECLINED_STATUS.has(status.toLowerCase());
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

/**
 * Compute the digest from a raw set of audit_logs rows. Pure function so the
 * tests can feed in a fixture without touching Supabase.
 *
 * `prior` is the previous-week set of rows; we only need totals/counts from
 * it for the vs_last_week comparison so we don't bother with the per-service
 * roll-up there.
 */
export function aggregateDigest(
  userId: string,
  weekStart: Date,
  current: AuditLogRow[],
  prior: AuditLogRow[]
): DigestData {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Bucket rows: charges (success) drive spend; declines tracked separately.
  let totalSpent = 0;
  let declinedCount = 0;
  let largest: RecentTransaction | null = null;

  const perService = new Map<string, ServiceBreakdown>();
  const perAgent = new Map<string, AgentBreakdown>();

  for (const row of current) {
    const amount = typeof row.amount_usd === "number" ? row.amount_usd : 0;
    const service = (row.service ?? "unknown").toLowerCase();

    if (isDeclined(row.status)) {
      declinedCount += 1;
    }

    if (isSuccess(row.status) && amount > 0) {
      totalSpent += amount;

      // Per-service rollup
      const cur = perService.get(service) ?? {
        service,
        total_spent_usd: 0,
        transaction_count: 0,
      };
      cur.total_spent_usd += amount;
      cur.transaction_count += 1;
      perService.set(service, cur);

      // Per-agent rollup — only when agent_id is set on the row
      if (row.agent_id) {
        const a = perAgent.get(row.agent_id) ?? {
          agent_id: row.agent_id,
          transaction_count: 0,
          total_spent_usd: 0,
        };
        a.transaction_count += 1;
        a.total_spent_usd += amount;
        perAgent.set(row.agent_id, a);
      }

      // Largest single successful charge
      if (!largest || amount > largest.amount_usd) {
        largest = {
          id: row.id,
          created_at: row.created_at,
          service,
          amount_usd: amount,
          status: row.status ?? "success",
          description: row.description,
        };
      }
    }
  }

  const successCount = current.filter((r) => isSuccess(r.status)).length;
  // success_rate over decisions (success + decline). A pending row should not
  // count as a failure — it just hasn't resolved yet, so we exclude it from
  // the denominator. This matches how the dashboard cards report success.
  const decided = successCount + declinedCount;
  const successRatePct = decided === 0 ? 100 : (successCount / decided) * 100;

  // Top 3 services by spend
  const top3 = Array.from(perService.values())
    .sort((a, b) => b.total_spent_usd - a.total_spent_usd)
    .slice(0, 3);

  // Top agents by count (then spend as tiebreaker)
  const topAgents = Array.from(perAgent.values())
    .sort(
      (a, b) =>
        b.transaction_count - a.transaction_count ||
        b.total_spent_usd - a.total_spent_usd
    )
    .slice(0, 5);

  // Recent successful transactions (top 5)
  const recent: RecentTransaction[] = current
    .filter((r) => isSuccess(r.status))
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      created_at: r.created_at,
      service: (r.service ?? "unknown").toLowerCase(),
      amount_usd: typeof r.amount_usd === "number" ? r.amount_usd : 0,
      status: r.status ?? "success",
      description: r.description,
    }));

  // Prior week comparison
  let priorTotal = 0;
  let priorCount = 0;
  for (const row of prior) {
    if (isSuccess(row.status) && typeof row.amount_usd === "number") {
      priorTotal += row.amount_usd;
      priorCount += 1;
    }
  }
  const spentDiffPct =
    priorTotal > 0 ? ((totalSpent - priorTotal) / priorTotal) * 100 : null;
  const countDiffPct =
    priorCount > 0 ? ((successCount - priorCount) / priorCount) * 100 : null;

  return {
    user_id: userId,
    week_start: weekStart.toISOString(),
    week_end: weekEnd.toISOString(),
    total_spent_usd: round2(totalSpent),
    transaction_count: successCount,
    top_3_services: top3.map((s) => ({
      ...s,
      total_spent_usd: round2(s.total_spent_usd),
    })),
    largest_charge: largest
      ? { ...largest, amount_usd: round2(largest.amount_usd) }
      : null,
    declined_count: declinedCount,
    success_rate_pct: round1(successRatePct),
    top_agents: topAgents.map((a) => ({
      ...a,
      total_spent_usd: round2(a.total_spent_usd),
    })),
    recent_transactions: recent.map((r) => ({
      ...r,
      amount_usd: round2(r.amount_usd),
    })),
    vs_last_week: {
      spent_diff_pct: spentDiffPct === null ? null : round1(spentDiffPct),
      count_diff_pct: countDiffPct === null ? null : round1(countDiffPct),
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Supabase-backed entry point
// ---------------------------------------------------------------------------

/**
 * Fetch the current week + prior week from audit_logs and build a digest.
 * `client` is a Supabase admin client (service-role). Callers run this from
 * a trusted server context (cron job) so we deliberately skip RLS.
 */
export async function buildWeeklyDigest(
  client: SupabaseClient,
  userId: string,
  weekStart: Date
): Promise<DigestData> {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const priorStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Two parallel queries — current and prior 7-day windows. We need raw rows
  // for the current window (for largest_charge, top_3, agents). For the
  // prior window we only use totals so we could narrow the SELECT, but the
  // row count is bounded (one user, one week) so we just fetch the full row.
  const SELECT_COLS =
    "id, created_at, user_id, service, status, amount_usd, description, transaction_id, transaction_type, agent_id";

  const [currentRes, priorRes] = await Promise.all([
    client
      .from("audit_logs")
      .select(SELECT_COLS)
      .eq("user_id", userId)
      .gte("created_at", weekStart.toISOString())
      .lt("created_at", weekEnd.toISOString())
      .order("created_at", { ascending: false }),
    client
      .from("audit_logs")
      .select(SELECT_COLS)
      .eq("user_id", userId)
      .gte("created_at", priorStart.toISOString())
      .lt("created_at", weekStart.toISOString()),
  ]);

  if (currentRes.error) {
    throw new Error(
      `audit_logs query failed for current week: ${currentRes.error.message}`
    );
  }
  if (priorRes.error) {
    throw new Error(
      `audit_logs query failed for prior week: ${priorRes.error.message}`
    );
  }

  const current = (currentRes.data ?? []) as AuditLogRow[];
  const prior = (priorRes.data ?? []) as AuditLogRow[];

  return aggregateDigest(userId, weekStart, current, prior);
}

// ---------------------------------------------------------------------------
// Week math helper
// ---------------------------------------------------------------------------

/**
 * Returns the Monday 00:00 UTC of the ISO week that contains `now`. Used by
 * the cron route to compute "last week" when no explicit weekStart is given:
 * we send the digest on Monday 9 UTC, covering the previous Monday→Sunday.
 */
export function getStartOfPreviousIsoWeek(now: Date): Date {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  // Day of week: 0=Sun .. 6=Sat. ISO week starts Monday.
  const dow = d.getUTCDay();
  // Distance back to the most recent Monday (today included).
  const offsetToThisMonday = dow === 0 ? 6 : dow - 1;
  // Previous Monday = this-week Monday - 7 days.
  const prevMonday = new Date(d.getTime());
  prevMonday.setUTCDate(d.getUTCDate() - offsetToThisMonday - 7);
  prevMonday.setUTCHours(0, 0, 0, 0);
  return prevMonday;
}
