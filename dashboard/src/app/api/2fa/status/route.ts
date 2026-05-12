/**
 * GET /api/2fa/status
 *
 * Returns whether the authenticated user has 2FA enabled. Used by the
 * Settings page to render the right UI on first load, and by the client-
 * side 2FA prompt to know whether to bother asking for a code at all.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const admin = getAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("totp_enabled, totp_recovery_codes")
    .eq("id", user.id)
    .single<{ totp_enabled: boolean | null; totp_recovery_codes: string[] | null }>();

  if (error) {
    console.error("[api/2fa/status] DB read error:", error);
    return NextResponse.json({ error: "Failed to fetch 2FA status" }, { status: 500 });
  }

  return NextResponse.json({
    enabled: !!data?.totp_enabled,
    recoveryCodesRemaining: data?.totp_recovery_codes?.length ?? 0,
  });
}
