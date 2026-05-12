import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/subscriptions
 *
 * List every subscription row for the authenticated user. Backs the
 * /dashboard/subscriptions page and any client-side refresh after a
 * cancel/pause mutation. RLS is enforced server-side: we use the admin
 * client (service role) but filter by the session user's id, so a leaked
 * session can never read other users' subscriptions.
 *
 * Response: { subscriptions: SubscriptionRow[] }
 *
 * If the `subscriptions` table is missing (migration 010 not yet applied to
 * this environment) we return an empty array rather than 500 so the page
 * still renders with an empty state instead of an error wall.
 */

export interface SubscriptionRow {
  id: string;
  user_id: string;
  service: string;
  amount_usd: number | string | null;
  currency: string | null;
  interval: "monthly" | "yearly" | "weekly";
  status: "active" | "paused" | "cancelled" | "past_due";
  description: string | null;
  started_at: string;
  next_charge_at: string;
  last_charged_at: string | null;
  cancelled_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/subscriptions] admin client unavailable:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  const { data, error } = await admin
    .from("subscriptions")
    .select(
      "id, user_id, service, amount_usd, currency, interval, status, description, " +
      "started_at, next_charge_at, last_charged_at, cancelled_at, metadata, " +
      "created_at, updated_at"
    )
    .eq("user_id", user.id)
    // Active first, then by upcoming charge date — matches the order the MCP
    // `list_subscriptions` tool uses so the surfaces feel coherent.
    .order("status", { ascending: true })
    .order("next_charge_at", { ascending: true });

  if (error) {
    // 42P01 = undefined_table → migration 010 not applied. Surface an empty
    // list so the dashboard page still renders with the empty state.
    if (error.code === "42P01") {
      return NextResponse.json({ subscriptions: [] });
    }
    console.error("[api/subscriptions] select error:", error);
    return NextResponse.json(
      { error: "Failed to load subscriptions" },
      { status: 500 }
    );
  }

  return NextResponse.json({ subscriptions: data ?? [] });
}
