import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface ManagedAccountOwnershipRow {
  id: string;
  user_id: string;
  status: string | null;
}

interface SuccessResponse {
  success: true;
}

interface ErrorResponse {
  error: string;
}

/**
 * DELETE /api/accounts/[id]
 *
 * Soft-revoke: sets managed_accounts.status = 'revoked'. The row is preserved
 * so we keep an audit trail of every managed account ever created.
 */
export async function DELETE(
  _req: NextRequest,
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

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/accounts DELETE] failed to create admin client:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  // Verify ownership before mutating.
  let row: ManagedAccountOwnershipRow | null = null;
  try {
    const { data, error } = await admin
      .from("managed_accounts")
      .select("id, user_id, status")
      .eq("id", accountId)
      .maybeSingle();

    if (error) {
      console.error("[api/accounts DELETE] lookup error:", error);
      return NextResponse.json(
        { error: "Failed to look up account" },
        { status: 500 }
      );
    }
    row = (data ?? null) as ManagedAccountOwnershipRow | null;
  } catch (err) {
    console.error("[api/accounts DELETE] unexpected lookup error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }

  if (!row || row.user_id !== user.id) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  if (row.status === "revoked") {
    // Idempotent — already revoked.
    return NextResponse.json({ success: true }, { status: 200 });
  }

  try {
    const { error } = await admin
      .from("managed_accounts")
      .update({ status: "revoked" })
      .eq("id", accountId)
      .eq("user_id", user.id);

    if (error) {
      console.error("[api/accounts DELETE] update error:", error);
      return NextResponse.json(
        { error: "Failed to revoke account" },
        { status: 500 }
      );
    }
  } catch (err) {
    console.error("[api/accounts DELETE] unexpected update error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }

  console.error(
    `[api/accounts DELETE] revoke_success user=${user.id} account=${accountId}`
  );
  return NextResponse.json({ success: true }, { status: 200 });
}
