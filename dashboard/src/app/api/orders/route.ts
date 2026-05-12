import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Public shape of an order. The product-meta fields are nullable because
// migration 005 (audit_logs product meta) may not have run yet on every
// environment, in which case we fall back to a narrower column set.
export interface Order {
  id: string;
  created_at: string;
  user_id: string;
  service: string;
  status: string;
  amount_usd: number;
  description: string | null;
  transaction_id: string | null;
  product_url: string | null;
  product_name: string | null;
  product_image_url: string | null;
  currency: string | null;
  merchant_country: string | null;
}

const SELECT_WITH_META =
  "id, created_at, user_id, service, status, amount_usd, description, transaction_id, product_url, product_name, product_image_url, currency, merchant_country";
const SELECT_BASE =
  "id, created_at, user_id, service, status, amount_usd, description, transaction_id";

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Auth via Supabase session. The user ID is derived server-side from the
  // verified auth cookie so a caller cannot read another user's orders.
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

  const service = searchParams.get("service") ?? undefined;
  const since = searchParams.get("since") ?? undefined;

  // Basic since-param validation — must be a parseable ISO date. If the
  // caller passes garbage we ignore it rather than returning a 400; this
  // keeps the endpoint forgiving for clients building URLs from form inputs.
  let sinceIso: string | undefined;
  if (since) {
    const parsed = new Date(since);
    if (!isNaN(parsed.getTime())) {
      sinceIso = parsed.toISOString();
    }
  }

  let client: ReturnType<typeof getAdminClient>;
  try {
    client = getAdminClient();
  } catch (err) {
    console.error("[api/orders] Failed to create Supabase admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  const buildQuery = (selectCols: string) => {
    let q = client
      .from("audit_logs")
      .select(selectCols)
      .eq("user_id", userId)
      .eq("status", "success")
      .gt("amount_usd", 0)
      .order("created_at", { ascending: false })
      .limit(100);

    if (service !== undefined) q = q.eq("service", service);
    if (sinceIso !== undefined) q = q.gte("created_at", sinceIso);

    return q;
  };

  try {
    const rich = await buildQuery(SELECT_WITH_META);

    if (rich.error) {
      // Most likely: migration 005 hasn't been applied yet. Retry with the
      // base column set so callers still get a useful response.
      console.error("[api/orders] Rich query failed, falling back:", rich.error);
      const base = await buildQuery(SELECT_BASE);
      if (base.error) {
        console.error("[api/orders] Base query also failed:", base.error);
        return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 });
      }
      const orders = (base.data ?? []) as unknown as Order[];
      return NextResponse.json({ orders }, { status: 200 });
    }

    const orders = (rich.data ?? []) as unknown as Order[];
    return NextResponse.json({ orders }, { status: 200 });
  } catch (err) {
    console.error("[api/orders] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
