/**
 * POST /api/2fa/disable
 *
 * Body: { code: string }
 *
 * Disable 2FA. Requires a valid TOTP code (or recovery code) — this is
 * itself a critical action, so we don't want a session-hijack to be able
 * to silently remove the second factor.
 *
 * On success: clears totp_secret, totp_recovery_codes, and flips
 * totp_enabled to false. The user can re-enrol from scratch via
 * /api/2fa/setup.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import { verifyTotpCode, findRecoveryCodeMatch } from "@/lib/totp";

export const dynamic = "force-dynamic";

interface DisableBody {
  code: string;
}

function parseBody(parsed: unknown): DisableBody | null {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { code?: unknown }).code !== "string"
  ) {
    return null;
  }
  return { code: (parsed as DisableBody).code };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = parseBody(rawBody);
  if (!body) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }

  const admin = getAdminClient();
  const { data, error: readError } = await admin
    .from("users")
    .select("totp_secret, totp_enabled, totp_recovery_codes")
    .eq("id", user.id)
    .single<{
      totp_secret: string | null;
      totp_enabled: boolean | null;
      totp_recovery_codes: string[] | null;
    }>();

  if (readError) {
    console.error("[api/2fa/disable] DB read error:", readError);
    return NextResponse.json({ error: "Failed to disable 2FA" }, { status: 500 });
  }

  if (!data?.totp_enabled || !data?.totp_secret) {
    // Nothing to disable. Idempotent success-shape return so the UI can
    // settle into the "off" state.
    return NextResponse.json({ enabled: false });
  }

  const totpOk = verifyTotpCode(body.code, data.totp_secret);
  const recoveryIdx = totpOk
    ? -1
    : findRecoveryCodeMatch(body.code, data.totp_recovery_codes ?? []);

  if (!totpOk && recoveryIdx < 0) {
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  }

  const { error: updateError } = await admin
    .from("users")
    .update({
      totp_enabled: false,
      totp_secret: null,
      totp_recovery_codes: null,
    })
    .eq("id", user.id);

  if (updateError) {
    console.error("[api/2fa/disable] DB update error:", updateError);
    return NextResponse.json({ error: "Failed to disable 2FA" }, { status: 500 });
  }

  return NextResponse.json({ enabled: false });
}
