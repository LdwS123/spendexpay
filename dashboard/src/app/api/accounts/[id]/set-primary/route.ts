import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface ManagedAccountOwnershipRow {
  id: string;
  user_id: string;
  service: string;
  status: string | null;
}

interface SetPrimaryBody {
  primary?: boolean;
}

interface SuccessResponse {
  success: true;
  isPrimary: boolean;
}

interface ErrorResponse {
  error: string;
}

/**
 * POST /api/accounts/[id]/set-primary
 *
 * Toggles managed_accounts.is_primary for the given account. When marking
 * a row as primary, other accounts for the same (user_id, service) pair
 * are demoted to is_primary = false so the constraint of "one primary per
 * service" is preserved.
 *
 * Body: { primary: boolean }. Defaults to `true` if not supplied.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  const { id: accountId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  if (!accountId) {
    return NextResponse.json({ error: "Missing account id" }, { status: 400 });
  }

  let body: SetPrimaryBody = {};
  try {
    const parsed = (await req.json()) as unknown;
    if (parsed && typeof parsed === "object") {
      body = parsed as SetPrimaryBody;
    }
  } catch {
    // Empty body is fine — default to primary=true.
  }

  const makePrimary = body.primary !== false;

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/accounts/set-primary] admin client error:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  // Ownership + service lookup.
  let row: ManagedAccountOwnershipRow | null = null;
  try {
    const { data, error } = await admin
      .from("managed_accounts")
      .select("id, user_id, service, status")
      .eq("id", accountId)
      .maybeSingle();

    if (error) {
      console.error("[api/accounts/set-primary] lookup error:", error);
      return NextResponse.json(
        { error: "Failed to look up account" },
        { status: 500 }
      );
    }
    row = (data ?? null) as ManagedAccountOwnershipRow | null;
  } catch (err) {
    console.error("[api/accounts/set-primary] unexpected lookup error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }

  if (!row || row.user_id !== user.id) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  if (row.status === "revoked") {
    return NextResponse.json(
      { error: "Cannot change primary status on a revoked account." },
      { status: 409 }
    );
  }

  try {
    // If we're promoting this account to primary, demote any siblings on the
    // same service first. Best-effort: we ignore an error here because the
    // is_primary column may not exist yet (early schema). The follow-up update
    // is the canonical state change.
    if (makePrimary) {
      const { error: demoteErr } = await admin
        .from("managed_accounts")
        .update({ is_primary: false })
        .eq("user_id", user.id)
        .eq("service", row.service)
        .neq("id", accountId);

      if (demoteErr && demoteErr.code !== "42703") {
        // 42703 = undefined_column; tolerate if is_primary not yet in schema.
        console.error(
          "[api/accounts/set-primary] sibling demotion error:",
          demoteErr
        );
      }
    }

    const { error } = await admin
      .from("managed_accounts")
      .update({ is_primary: makePrimary })
      .eq("id", accountId)
      .eq("user_id", user.id);

    if (error) {
      console.error("[api/accounts/set-primary] update error:", error);
      return NextResponse.json(
        { error: "Failed to update primary status" },
        { status: 500 }
      );
    }
  } catch (err) {
    console.error("[api/accounts/set-primary] unexpected update error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { success: true, isPrimary: makePrimary },
    { status: 200 }
  );
}
