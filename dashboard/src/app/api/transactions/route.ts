import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export interface AuditLog {
  id: string;
  created_at: string;
  user_id: string;
  service: string;
  status: string;
  amount_usd: number;
  description: string | null;
  transaction_id: string | null;
  transaction_type: string | null;
  agent_id: string | null;
  error_message: string | null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Auth via Supabase session — never trust client-supplied user identifiers.
  // The user ID is derived server-side from the verified auth cookie, so a
  // caller cannot read another user's transactions by spoofing a header.
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  const userId = user.id;

  const { searchParams } = req.nextUrl;

  const rawLimit = parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 100);

  const rawOffset = parseInt(searchParams.get("offset") ?? "0", 10);
  const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);

  const service = searchParams.get("service") ?? undefined;

  // ?status=success  → filter eq "success"
  // ?status=failed   → filter to payment_failed OR deploy_failed_after_payment
  // (absent)         → no filter
  const rawStatus = searchParams.get("status") ?? undefined;

  let client: ReturnType<typeof getAdminClient>;
  try {
    client = getAdminClient();
  } catch (err) {
    console.error("[api/transactions] Failed to create Supabase admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  const FAILED_STATUSES = ["payment_failed", "deploy_failed_after_payment"];

  try {
    // Count query — same filters, no pagination
    let countQuery = client
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    if (service !== undefined) countQuery = countQuery.eq("service", service);
    if (rawStatus === "success") {
      countQuery = countQuery.eq("status", "success");
    } else if (rawStatus === "failed") {
      countQuery = countQuery.in("status", FAILED_STATUSES);
    }

    // Data query — built before awaiting so we can run it in parallel with
    // the count query (they share no result inputs).
    let dataQuery = client
      .from("audit_logs")
      .select(
        "id, created_at, user_id, service, status, amount_usd, description, transaction_id, transaction_type, agent_id, error_message"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (service !== undefined) dataQuery = dataQuery.eq("service", service);
    if (rawStatus === "success") {
      dataQuery = dataQuery.eq("status", "success");
    } else if (rawStatus === "failed") {
      dataQuery = dataQuery.in("status", FAILED_STATUSES);
    }

    const [
      { count, error: countError },
      { data, error: dataError },
    ] = await Promise.all([countQuery, dataQuery]);

    if (countError) {
      console.error("[api/transactions] Count query error:", countError);
      return NextResponse.json({ error: "Failed to fetch transaction count" }, { status: 500 });
    }

    if (dataError) {
      console.error("[api/transactions] Data query error:", dataError);
      return NextResponse.json({ error: "Failed to fetch transactions" }, { status: 500 });
    }

    const transactions: AuditLog[] = (data ?? []) as AuditLog[];

    return NextResponse.json({ transactions, total: count ?? 0 }, { status: 200 });
  } catch (err) {
    console.error("[api/transactions] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
