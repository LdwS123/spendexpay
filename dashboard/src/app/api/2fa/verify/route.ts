/**
 * POST /api/2fa/verify
 *
 * Body: { code: string }
 *
 * Finalises the 2FA enrolment flow. The user has already scanned the QR
 * from /api/2fa/setup; this endpoint proves they got the secret right by
 * checking a live TOTP code.
 *
 * On success:
 *  - Sets totp_enabled = true
 *  - Generates 10 recovery codes, stores their hashes, returns the
 *    plaintext codes EXACTLY ONCE. The client must display them and tell
 *    the user to save them somewhere safe.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import { verifyTotpCode, generateRecoveryCodes } from "@/lib/totp";

export const dynamic = "force-dynamic";

interface VerifyBody {
  code: string;
}

function parseBody(parsed: unknown): VerifyBody | null {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { code?: unknown }).code !== "string"
  ) {
    return null;
  }
  return { code: (parsed as VerifyBody).code };
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
    .select("totp_secret, totp_enabled")
    .eq("id", user.id)
    .single<{ totp_secret: string | null; totp_enabled: boolean | null }>();

  if (readError) {
    console.error("[api/2fa/verify] DB read error:", readError);
    return NextResponse.json({ error: "Failed to verify 2FA" }, { status: 500 });
  }

  if (!data?.totp_secret) {
    // The user never called /api/2fa/setup, or it failed to persist.
    return NextResponse.json({ error: "2fa_not_started" }, { status: 409 });
  }

  if (!verifyTotpCode(body.code, data.totp_secret)) {
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  }

  // Code is good. Flip the flag and provision recovery codes.
  const { plain, hashed } = generateRecoveryCodes();

  const { error: updateError } = await admin
    .from("users")
    .update({
      totp_enabled: true,
      totp_recovery_codes: hashed,
    })
    .eq("id", user.id);

  if (updateError) {
    console.error("[api/2fa/verify] DB update error:", updateError);
    return NextResponse.json({ error: "Failed to enable 2FA" }, { status: 500 });
  }

  return NextResponse.json({
    enabled: true,
    recoveryCodes: plain,
  });
}
