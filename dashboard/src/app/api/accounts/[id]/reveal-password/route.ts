import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import { decryptManagedPassword } from "@/lib/crypto";

export const dynamic = "force-dynamic";

interface ManagedAccountSecretRow {
  id: string;
  user_id: string;
  password_encrypted: string | null;
  status: string | null;
}

interface RevealResponse {
  password: string;
}

interface ErrorResponse {
  error: string;
}

/**
 * POST /api/accounts/[id]/reveal-password
 *
 * Returns the plaintext password for a managed account belonging to the
 * authenticated user. Every successful and failed reveal attempt is logged
 * to stderr for the audit trail. The plaintext is never logged.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<RevealResponse | ErrorResponse>> {
  const { id: accountId } = await params;

  // 1) Authenticate.
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    console.error(
      `[api/accounts/reveal-password] unauthenticated reveal attempt account=${accountId}`
    );
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  if (!accountId) {
    return NextResponse.json({ error: "Missing account id" }, { status: 400 });
  }

  // 2) Fetch the encrypted secret + verify ownership.
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error(
      "[api/accounts/reveal-password] failed to create admin client:",
      err
    );
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  let row: ManagedAccountSecretRow | null = null;
  try {
    const { data, error } = await admin
      .from("managed_accounts")
      .select("id, user_id, password_encrypted, status")
      .eq("id", accountId)
      .maybeSingle();

    if (error) {
      console.error(
        "[api/accounts/reveal-password] managed_accounts query error:",
        error
      );
      return NextResponse.json(
        { error: "Failed to look up account" },
        { status: 500 }
      );
    }
    row = (data ?? null) as ManagedAccountSecretRow | null;
  } catch (err) {
    console.error(
      "[api/accounts/reveal-password] unexpected DB error:",
      err
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }

  if (!row) {
    console.error(
      `[api/accounts/reveal-password] not_found user=${user.id} account=${accountId}`
    );
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  if (row.user_id !== user.id) {
    console.error(
      `[api/accounts/reveal-password] ownership_mismatch user=${user.id} account=${accountId}`
    );
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  if (row.status === "revoked") {
    return NextResponse.json(
      { error: "This account has been revoked." },
      { status: 410 }
    );
  }

  if (!row.password_encrypted) {
    return NextResponse.json(
      { error: "No password is stored for this account yet." },
      { status: 404 }
    );
  }

  // 3) Decrypt and return. Never log the plaintext.
  try {
    const plaintext = decryptManagedPassword(row.password_encrypted);
    console.error(
      `[api/accounts/reveal-password] reveal_success user=${user.id} account=${accountId}`
    );
    return NextResponse.json({ password: plaintext }, { status: 200 });
  } catch (err) {
    console.error(
      "[api/accounts/reveal-password] decryption error:",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { error: "Failed to decrypt password. Contact support." },
      { status: 500 }
    );
  }
}
