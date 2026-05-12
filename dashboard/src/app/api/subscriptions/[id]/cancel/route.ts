import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/subscriptions/[id]/cancel
 *
 * Cancel a subscription from the authenticated dashboard UI. Mirrors the
 * MCP `cancel_subscription` tool: transitions status to 'cancelled' and
 * stamps cancelled_at. Ownership is enforced via (id, user_id) filter so a
 * compromised session cannot cancel a row that does not belong to the
 * caller.
 *
 * Idempotent: cancelling a row that is already cancelled returns 200 with
 * the existing row state instead of an error.
 *
 * Body: none
 * Response: { subscription: SubscriptionRow } | { error: string }
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  _req: NextRequest,
  context: RouteContext
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Invalid subscription id" }, { status: 400 });
  }

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
    console.error("[api/subscriptions/cancel] admin client unavailable:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  // Verify ownership and current state. We return 404 for both "not found"
  // and "owned by someone else" — the two are indistinguishable from the
  // caller so an attacker can't probe IDs.
  const { data: existing, error: selectError } = await admin
    .from("subscriptions")
    .select("id, user_id, status, cancelled_at, updated_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (selectError) {
    if (selectError.code === "42P01") {
      return NextResponse.json(
        { error: "Subscriptions are not enabled on this account yet" },
        { status: 503 }
      );
    }
    console.error("[api/subscriptions/cancel] select error:", selectError);
    return NextResponse.json({ error: "Failed to load subscription" }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.status === "cancelled") {
    return NextResponse.json({ subscription: existing }, { status: 200 });
  }

  const { data: updated, error: updateError } = await admin
    .from("subscriptions")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", user.id)
    .select(
      "id, user_id, service, amount_usd, currency, interval, status, description, " +
      "started_at, next_charge_at, last_charged_at, cancelled_at, metadata, " +
      "created_at, updated_at"
    )
    .maybeSingle();

  if (updateError) {
    console.error("[api/subscriptions/cancel] update error:", updateError);
    return NextResponse.json({ error: "Failed to cancel subscription" }, { status: 500 });
  }

  return NextResponse.json({ subscription: updated }, { status: 200 });
}
