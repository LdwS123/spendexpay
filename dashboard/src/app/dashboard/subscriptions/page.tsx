import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import SubscriptionsClient, { type SubscriptionRow } from "./SubscriptionsClient";

export const dynamic = "force-dynamic";

/**
 * /dashboard/subscriptions
 *
 * Unified view of every recurring charge tracked for the user — Vercel Pro,
 * Netflix, Spotify, GitHub Pro, etc. Server-renders the initial list from
 * the admin client (RLS-scoped to the session user), then hands off to the
 * client component for the cancel/pause mutations.
 *
 * If migration 010 hasn't been applied to this environment yet, the
 * `subscriptions` table doesn't exist — we catch that case and render the
 * empty state instead of crashing the dashboard.
 */
async function loadSubscriptions(userId: string): Promise<SubscriptionRow[]> {
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch {
    return [];
  }

  try {
    const { data, error } = await admin
      .from("subscriptions")
      .select(
        "id, user_id, service, amount_usd, currency, interval, status, description, " +
        "started_at, next_charge_at, last_charged_at, cancelled_at, metadata, " +
        "created_at, updated_at"
      )
      .eq("user_id", userId)
      .order("status", { ascending: true })
      .order("next_charge_at", { ascending: true });

    if (error) {
      // 42P01 = undefined_table → migration 010 hasn't been applied here.
      // Render the empty state rather than the error banner so the page is
      // useful in any environment.
      if (error.code === "42P01") return [];
      console.error("[dashboard/subscriptions] query error:", error);
      return [];
    }
    // Cast through unknown because Supabase's typed client can't infer the
    // `subscriptions` table shape until generated types are regenerated.
    return (data ?? []) as unknown as SubscriptionRow[];
  } catch (err) {
    console.error("[dashboard/subscriptions] unexpected error:", err);
    return [];
  }
}

export default async function SubscriptionsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const subscriptions = await loadSubscriptions(user.id);

  // Pre-compute the headline stat server-side so the page paints with the
  // right number even before React hydrates.
  const activeSubs = subscriptions.filter((s) => s.status === "active");
  const monthlyTotal = activeSubs.reduce((sum, s) => {
    const amount = typeof s.amount_usd === "string" ? Number(s.amount_usd) : s.amount_usd ?? 0;
    switch (s.interval) {
      case "monthly":
        return sum + amount;
      case "yearly":
        return sum + amount / 12;
      case "weekly":
        // 52 weeks / 12 months ≈ 4.345 weeks per month.
        return sum + amount * (52 / 12);
      default:
        return sum;
    }
  }, 0);

  return (
    <main>
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Ledger
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0a1220]">
              Subscriptions
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Recurring charges grouped by service, cadence, and renewal state.
          </p>
        </div>
        {subscriptions.length > 0 && (
          <span className="text-xs text-slate-400 shrink-0">
            {activeSubs.length} active · ${monthlyTotal.toFixed(2)}/mo
          </span>
        )}
        </div>
      </header>

      <div className="max-w-6xl px-4 py-7 sm:px-8">
        <SubscriptionsClient initialSubscriptions={subscriptions} />
      </div>
    </main>
  );
}
