/**
 * POST   /api/push/subscribe — store the user's PushSubscription
 * DELETE /api/push/subscribe — clear it
 *
 * Both endpoints are scoped to the currently authenticated dashboard user.
 * They update `users.push_subscription` (jsonb), which is read by
 * `sendPushToUser` in src/lib/push-notify.ts when a consent request fires.
 *
 * The subscription is opaque to us — endpoint + keys are pushed to the
 * browser's push service (Apple, Google, Mozilla) by the `web-push` npm
 * package using our VAPID keypair. We do not need to parse them.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── Wire shape ───────────────────────────────────────────────────────────────

interface PushSubscriptionWire {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Defensive validator. We're storing the result as jsonb so a typed
 * `JSON.parse` is not enough — we want to reject any payload that wouldn't
 * round-trip back into a usable PushSubscription on send.
 */
function parseSubscription(body: unknown): PushSubscriptionWire | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.endpoint !== "string" || b.endpoint.length === 0) return null;
  if (!b.keys || typeof b.keys !== "object") return null;
  const keys = b.keys as Record<string, unknown>;
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return null;
  }
  const expirationTime =
    typeof b.expirationTime === "number" ? b.expirationTime : null;
  return {
    endpoint: b.endpoint,
    expirationTime,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

async function getAuthedUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user.id;
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sub = parseSubscription(raw);
  if (!sub) {
    return NextResponse.json(
      {
        error:
          "Invalid push subscription. Expected { endpoint, keys: { p256dh, auth } }.",
      },
      { status: 400 }
    );
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/push/subscribe] POST admin error:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  // Single jsonb column. We deliberately overwrite — a user re-subscribing
  // from a different browser replaces the old endpoint. (Multi-device push
  // is a v2 problem; today we keep one subscription per user.)
  const { error } = await admin
    .from("users")
    .update({ push_subscription: sub })
    .eq("id", userId);

  if (error) {
    if (error.code === "42703") {
      // Column not migrated yet.
      return NextResponse.json(
        {
          error:
            "Push notifications are not enabled on this account yet. Please contact support.",
        },
        { status: 503 }
      );
    }
    console.error("[api/push/subscribe] POST update error:", error);
    return NextResponse.json(
      { error: "Failed to save subscription" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true }, { status: 200 });
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/push/subscribe] DELETE admin error:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  const { error } = await admin
    .from("users")
    .update({ push_subscription: null })
    .eq("id", userId);

  if (error && error.code !== "42703") {
    console.error("[api/push/subscribe] DELETE update error:", error);
    return NextResponse.json(
      { error: "Failed to clear subscription" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
