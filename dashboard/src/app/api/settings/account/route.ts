/**
 * DELETE /api/settings/account
 *
 * Permanently deletes the authenticated user from Supabase Auth.
 * The database schema's ON DELETE CASCADE triggers handle cleanup of
 * public.users, virtual_cards, rules, transactions, and mcp_tokens rows.
 *
 * This action is irreversible. The client is expected to show a
 * confirmation dialog before calling this endpoint.
 *
 * All debug output goes to console.error (stderr).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import { require2FA } from "@/lib/require-2fa";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// DELETE handler
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  // Authenticate via session cookie — confirm the caller is a real, active user
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    console.error("[api/settings/account] DELETE: Unauthenticated request.");
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const userId = user.id;

  // Account deletion is the most destructive action in the app — gate it
  // with 2FA when enabled. Graceful no-op for users who haven't opted in.
  const gate = await require2FA(userId, req);
  if (gate.blocked) return gate.response;

  // Admin client needed to call auth.admin.deleteUser
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    console.error("[api/settings/account] DELETE: Failed to create admin client:", err);
    return NextResponse.json({ error: "Database client unavailable" }, { status: 500 });
  }

  // Delete the user from Supabase Auth.
  // The service-role key is required — the anon or user-level key cannot call
  // auth.admin.deleteUser. CASCADE on the FK from public.users.id → auth.users.id
  // automatically removes all related rows.
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);

  if (deleteError) {
    console.error(
      `[api/settings/account] DELETE: Failed to delete user ${userId}:`,
      deleteError
    );
    return NextResponse.json({ error: "Failed to delete account" }, { status: 500 });
  }

  console.error(`[api/settings/account] DELETE: User ${userId} deleted successfully.`);
  return NextResponse.json({ success: true }, { status: 200 });
}
