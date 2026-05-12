import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// ─── types ────────────────────────────────────────────────────────────────────

interface RuleRow {
  id: string;
  user_id: string;
  rule_type: string;
  params: Record<string, unknown>;
  active: boolean;
  created_at: string;
}

interface UserRow {
  id: string;
  max_auto_charge_usd: number | null;
}

interface PostBody {
  max_auto_charge_usd: number;
  monthly_budget: number;
  allowed_services: string[] | null;
  // Merchant name substrings to block even within allowed MCC categories.
  // Optional in the request body — older clients that don't send this field
  // will simply leave the existing rule untouched (no-op deactivate+nothing).
  blocked_services?: string[] | null;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getAuthedUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user.id;
}

// ─── GET — fetch current rules ────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/rules] GET: failed to create admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  try {
    // Fetch max_auto_charge_usd from users table
    const { data: userData, error: userError } = await admin
      .from("users")
      .select("id, max_auto_charge_usd")
      .eq("id", userId)
      .single();

    if (userError) {
      console.error("[api/rules] GET: users query error:", userError);
      return NextResponse.json({ error: "Failed to fetch user settings" }, { status: 500 });
    }

    const user = userData as UserRow | null;

    // Fetch all active rules for this user
    const { data: rulesData, error: rulesError } = await admin
      .from("rules")
      .select("id, user_id, rule_type, params, active, created_at")
      .eq("user_id", userId)
      .eq("active", true);

    if (rulesError) {
      console.error("[api/rules] GET: rules query error:", rulesError);
      return NextResponse.json({ error: "Failed to fetch rules" }, { status: 500 });
    }

    const rules: RuleRow[] = (rulesData ?? []) as RuleRow[];

    // Extract well-known rule values from rules array
    const monthlyRule = rules.find((r) => r.rule_type === "max_amount_per_month");
    const allowedServicesRule = rules.find((r) => r.rule_type === "allowed_services");
    const blockedServicesRule = rules.find((r) => r.rule_type === "blocked_services");

    return NextResponse.json(
      {
        max_auto_charge_usd: user?.max_auto_charge_usd ?? 0,
        monthly_budget: (monthlyRule?.params?.usd as number) ?? null,
        allowed_services: (allowedServicesRule?.params?.services as string[]) ?? null,
        blocked_services: (blockedServicesRule?.params?.services as string[]) ?? null,
        rules,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[api/rules] GET: unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── POST — upsert rules ──────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { max_auto_charge_usd, monthly_budget, allowed_services } = body;
  const blocked_services = body.blocked_services ?? null;

  // Basic validation
  if (typeof max_auto_charge_usd !== "number" || max_auto_charge_usd < 0) {
    return NextResponse.json(
      { error: "max_auto_charge_usd must be a non-negative number" },
      { status: 400 }
    );
  }
  if (typeof monthly_budget !== "number" || monthly_budget < 0) {
    return NextResponse.json(
      { error: "monthly_budget must be a non-negative number" },
      { status: 400 }
    );
  }
  if (
    allowed_services !== null &&
    (!Array.isArray(allowed_services) ||
      allowed_services.some((s) => typeof s !== "string"))
  ) {
    return NextResponse.json(
      { error: "allowed_services must be an array of strings or null" },
      { status: 400 }
    );
  }
  if (
    blocked_services !== null &&
    (!Array.isArray(blocked_services) ||
      blocked_services.some((s) => typeof s !== "string"))
  ) {
    return NextResponse.json(
      { error: "blocked_services must be an array of strings or null" },
      { status: 400 }
    );
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/rules] POST: failed to create admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  try {
    // 1. Update max_auto_charge_usd on users table
    const { error: userUpdateError } = await admin
      .from("users")
      .update({ max_auto_charge_usd })
      .eq("id", userId);

    if (userUpdateError) {
      console.error("[api/rules] POST: users update error:", userUpdateError);
      return NextResponse.json({ error: "Failed to update auto-approve limit" }, { status: 500 });
    }

    // 2. Upsert max_amount_per_month rule
    //    Supabase upsert with onConflict requires a unique constraint.
    //    We match on (user_id, rule_type) by first deactivating old rows and inserting fresh.
    const { error: deactivateMonthlyError } = await admin
      .from("rules")
      .update({ active: false })
      .eq("user_id", userId)
      .eq("rule_type", "max_amount_per_month");

    if (deactivateMonthlyError) {
      console.error("[api/rules] POST: deactivate monthly rule error:", deactivateMonthlyError);
      return NextResponse.json({ error: "Failed to update monthly budget rule" }, { status: 500 });
    }

    const { error: insertMonthlyError } = await admin.from("rules").insert({
      user_id: userId,
      rule_type: "max_amount_per_month",
      params: { usd: monthly_budget },
      active: true,
    });

    if (insertMonthlyError) {
      console.error("[api/rules] POST: insert monthly rule error:", insertMonthlyError);
      return NextResponse.json({ error: "Failed to save monthly budget rule" }, { status: 500 });
    }

    // 3. Upsert allowed_services rule (deactivate old, insert new if provided)
    const { error: deactivateServicesError } = await admin
      .from("rules")
      .update({ active: false })
      .eq("user_id", userId)
      .eq("rule_type", "allowed_services");

    if (deactivateServicesError) {
      console.error(
        "[api/rules] POST: deactivate allowed_services rule error:",
        deactivateServicesError
      );
      return NextResponse.json(
        { error: "Failed to update allowed services rule" },
        { status: 500 }
      );
    }

    if (allowed_services !== null && allowed_services.length > 0) {
      const { error: insertServicesError } = await admin.from("rules").insert({
        user_id: userId,
        rule_type: "allowed_services",
        params: { services: allowed_services },
        active: true,
      });

      if (insertServicesError) {
        console.error("[api/rules] POST: insert allowed_services rule error:", insertServicesError);
        return NextResponse.json(
          { error: "Failed to save allowed services rule" },
          { status: 500 }
        );
      }
    }

    // 4. Upsert blocked_services rule (merchant-exclusion list, takes priority
    //    over allowed MCC categories). Same deactivate-then-insert pattern as
    //    above for parity until the rules table grows a unique constraint on
    //    (user_id, rule_type) that supports real upserts.
    const { error: deactivateBlockedError } = await admin
      .from("rules")
      .update({ active: false })
      .eq("user_id", userId)
      .eq("rule_type", "blocked_services");

    if (deactivateBlockedError) {
      console.error(
        "[api/rules] POST: deactivate blocked_services rule error:",
        deactivateBlockedError
      );
      return NextResponse.json(
        { error: "Failed to update merchant exclusions" },
        { status: 500 }
      );
    }

    if (blocked_services !== null && blocked_services.length > 0) {
      const { error: insertBlockedError } = await admin.from("rules").insert({
        user_id: userId,
        rule_type: "blocked_services",
        params: { services: blocked_services },
        active: true,
      });

      if (insertBlockedError) {
        console.error("[api/rules] POST: insert blocked_services rule error:", insertBlockedError);
        return NextResponse.json(
          { error: "Failed to save merchant exclusions" },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error("[api/rules] POST: unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
