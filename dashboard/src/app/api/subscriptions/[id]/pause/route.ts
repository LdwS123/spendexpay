import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/subscriptions/[id]/pause
 *
 * Pause a subscription for one renewal cycle. Transitions status to
 * 'paused' and pushes `next_charge_at` forward by one month (the most
 * common case). The V3 renewal cron skips rows where status='paused', so
 * no charge is made until the user explicitly resumes via this endpoint
 * (POST with action="resume") or it's left to expire.
 *
 * Body: { action?: "pause" | "resume" }  default: "pause"
 * Response: { subscription: SubscriptionRow } | { error: string }
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PostBody {
  action?: unknown;
}

export async function POST(
  req: NextRequest,
  context: RouteContext
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Invalid subscription id" }, { status: 400 });
  }

  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    // Empty body is fine — defaults to "pause".
  }
  const action =
    typeof body.action === "string" && body.action === "resume" ? "resume" : "pause";

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
    console.error("[api/subscriptions/pause] admin client unavailable:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  const { data: existing, error: selectError } = await admin
    .from("subscriptions")
    .select("id, user_id, status, next_charge_at")
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
    console.error("[api/subscriptions/pause] select error:", selectError);
    return NextResponse.json({ error: "Failed to load subscription" }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.status === "cancelled") {
    return NextResponse.json(
      { error: "Cannot pause a cancelled subscription" },
      { status: 409 }
    );
  }

  // Compute the patch — pause adds one month to next_charge_at and flips
  // status to 'paused'. Resume flips back to 'active' and leaves
  // next_charge_at where it is (UI may want to surface "next charge in N
  // days" using the already-pushed timestamp).
  const patch: Record<string, unknown> = {};
  if (action === "pause") {
    const nextCharge = new Date(existing.next_charge_at);
    nextCharge.setUTCMonth(nextCharge.getUTCMonth() + 1);
    patch["status"] = "paused";
    patch["next_charge_at"] = nextCharge.toISOString();
  } else {
    patch["status"] = "active";
  }

  const { data: updated, error: updateError } = await admin
    .from("subscriptions")
    .update(patch)
    .eq("id", id)
    .eq("user_id", user.id)
    .select(
      "id, user_id, service, amount_usd, currency, interval, status, description, " +
      "started_at, next_charge_at, last_charged_at, cancelled_at, metadata, " +
      "created_at, updated_at"
    )
    .maybeSingle();

  if (updateError) {
    console.error("[api/subscriptions/pause] update error:", updateError);
    return NextResponse.json(
      { error: `Failed to ${action} subscription` },
      { status: 500 }
    );
  }

  return NextResponse.json({ subscription: updated }, { status: 200 });
}
