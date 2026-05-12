import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/consent/[id]/decide-from-dashboard
 *
 * Records a consent decision made from the authenticated dashboard UI.
 *
 * This is intentionally separate from /api/consent/[id]/decide (if it exists),
 * which is used by the email/Telegram out-of-band flow with HMAC-signed
 * tokens. Here we authenticate via the Supabase session cookie and verify
 * ownership of the consent_request row directly.
 *
 * Body: { option: string }
 * Response: { success: true } | { error: string }
 */

interface PostBody {
  option?: unknown;
}

interface ConsentRequestRow {
  id: string;
  user_id: string;
  options: string[] | null;
  status: string;
  expires_at: string | null;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  req: NextRequest,
  context: RouteContext
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Invalid consent id" }, { status: 400 });
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  // ── Body parsing ─────────────────────────────────────────────────────────
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const option = body.option;
  if (typeof option !== "string" || option.length === 0) {
    return NextResponse.json(
      { error: "option must be a non-empty string" },
      { status: 400 }
    );
  }

  // ── Admin client ─────────────────────────────────────────────────────────
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error(
      "[api/consent/decide-from-dashboard] admin client unavailable:",
      err
    );
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  // ── Load + verify ownership ──────────────────────────────────────────────
  let row: ConsentRequestRow | null = null;
  try {
    const { data, error } = await admin
      .from("consent_requests")
      .select("id, user_id, options, status, expires_at")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      if (error.code === "42P01") {
        return NextResponse.json(
          { error: "Consent requests are not enabled on this account yet" },
          { status: 503 }
        );
      }
      console.error("[api/consent/decide-from-dashboard] select error:", error);
      return NextResponse.json(
        { error: "Failed to load consent request" },
        { status: 500 }
      );
    }
    row = (data ?? null) as ConsentRequestRow | null;
  } catch (err) {
    console.error("[api/consent/decide-from-dashboard] unexpected:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.user_id !== user.id) {
    // 404 rather than 403 so we don't leak existence of other users' rows.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.status !== "pending") {
    return NextResponse.json(
      { error: `Consent request is already ${row.status}` },
      { status: 409 }
    );
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "Consent request has expired" },
      { status: 410 }
    );
  }

  // ── Validate option against allowed list ─────────────────────────────────
  const allowed = Array.isArray(row.options)
    ? row.options.filter(
        (o): o is string => typeof o === "string" && o.length > 0
      )
    : [];
  if (allowed.length > 0 && !allowed.includes(option)) {
    return NextResponse.json(
      { error: "Option not in allowed list for this request" },
      { status: 400 }
    );
  }

  // ── Decide mapping ───────────────────────────────────────────────────────
  // "decline" → declined; everything else → approved.
  const newStatus =
    option.toLowerCase() === "decline" ? "declined" : "approved";

  try {
    const { error: updateError } = await admin
      .from("consent_requests")
      .update({
        status: newStatus,
        decision: option,
        decision_made_at: new Date().toISOString(),
      })
      .eq("id", id)
      // Guard against TOCTOU: only flip if still pending.
      .eq("status", "pending");

    if (updateError) {
      console.error(
        "[api/consent/decide-from-dashboard] update error:",
        updateError
      );
      return NextResponse.json(
        { error: "Failed to record decision" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error(
      "[api/consent/decide-from-dashboard] unexpected update:",
      err
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
