import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface AuditLogRow {
  service: string;
  status: string;
  amount_usd: number | null;
  created_at: string;
}

interface DailySpend {
  date: string; // YYYY-MM-DD
  amount: number;
}

interface ServiceBreakdown {
  service: string;
  amount: number;
}

export interface SpendingResponse {
  /** Total EUR spent this calendar month (success only) */
  monthTotalUsd: number;
  /** Number of successful transactions this calendar month */
  monthTransactionCount: number;
  /** Top service by spend this month (or null if none) */
  topService: string | null;
  /** Top 5 services by spend this month */
  serviceBreakdown: ServiceBreakdown[];
  /** Last 7 calendar days — each entry is { date: "YYYY-MM-DD", amount } */
  dailySpend: DailySpend[];
  /** True when the user has no transactions at all */
  isEmpty: boolean;
}

export async function GET(): Promise<NextResponse> {
  // Auth via Supabase session — never trust client-supplied user identifiers.
  // The user ID is derived server-side from the verified auth cookie, so a
  // caller cannot read another user's data by spoofing a header.
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  const userId = user.id;

  // Start of current calendar month in UTC
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  // Start of the 7-day window (today - 6 days, so we get today + 6 prior days)
  const sevenDaysAgo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)
  ).toISOString();

  let client: ReturnType<typeof getAdminClient>;
  try {
    client = getAdminClient();
  } catch (err) {
    console.error("[api/spending] Failed to create Supabase admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  try {
    // Single query: fetch all rows we need (month rows cover the 7-day window too
    // as the month started at most 31 days ago, so we query from monthStart and
    // separately query the 7-day window only when monthStart > sevenDaysAgo).
    // To keep it simple we fetch from the earliest of the two start dates.
    const queryStart = monthStart < sevenDaysAgo ? monthStart : sevenDaysAgo;

    // Run the two independent queries in parallel — they share no inputs and
    // both must complete before we can respond.
    const [
      { data, error },
      { count: totalCount, error: totalError },
    ] = await Promise.all([
      client
        .from("audit_logs")
        .select("service, status, amount_usd, created_at")
        .eq("user_id", userId)
        .gte("created_at", queryStart)
        .order("created_at", { ascending: true }),
      client
        .from("audit_logs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
    ]);

    if (error) {
      console.error("[api/spending] Query error:", error);
      return NextResponse.json({ error: "Failed to fetch spending data" }, { status: 500 });
    }

    if (totalError) {
      console.error("[api/spending] Total count query error:", totalError);
      return NextResponse.json({ error: "Failed to fetch transaction count" }, { status: 500 });
    }

    const rows: AuditLogRow[] = (data ?? []) as AuditLogRow[];
    const isEmpty = (totalCount ?? 0) === 0;

    // ── Month aggregates ─────────────────────────────────────────────────────
    let monthTotalUsd = 0;
    let monthTransactionCount = 0;
    const byService: Record<string, number> = {};

    for (const row of rows) {
      if (row.created_at < monthStart) continue; // outside current month
      if (row.status !== "success") continue;

      const amount = row.amount_usd ?? 0;
      monthTotalUsd += amount;
      monthTransactionCount += 1;

      if (row.service) {
        byService[row.service] = (byService[row.service] ?? 0) + amount;
      }
    }

    // Round month total
    monthTotalUsd = Math.round(monthTotalUsd * 100) / 100;

    // Top 5 services by spend (descending)
    const serviceBreakdown: ServiceBreakdown[] = Object.entries(byService)
      .map(([service, amount]) => ({ service, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    const topService = serviceBreakdown[0]?.service ?? null;

    // ── Daily spend — last 7 days ────────────────────────────────────────────
    // Build a map keyed by YYYY-MM-DD initialised to 0 for each of the 7 days
    const dailyMap: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)
      );
      const key = d.toISOString().slice(0, 10); // "YYYY-MM-DD"
      dailyMap[key] = 0;
    }

    for (const row of rows) {
      if (row.status !== "success") continue;
      const day = row.created_at.slice(0, 10);
      if (day in dailyMap) {
        dailyMap[day] = (dailyMap[day] ?? 0) + (row.amount_usd ?? 0);
      }
    }

    const dailySpend: DailySpend[] = Object.entries(dailyMap).map(([date, amount]) => ({
      date,
      amount: Math.round(amount * 100) / 100,
    }));

    const response: SpendingResponse = {
      monthTotalUsd,
      monthTransactionCount,
      topService,
      serviceBreakdown,
      dailySpend,
      isEmpty,
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    console.error("[api/spending] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
