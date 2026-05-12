/**
 * POST /api/2fa/setup
 *
 * Begin the 2FA enrolment flow.
 *  - Generates a fresh TOTP secret.
 *  - Stores it on the user row but does NOT set totp_enabled yet — the
 *    user must prove they scanned the QR by calling /api/2fa/verify with
 *    a valid code first.
 *  - Returns the secret (so the user can paste it into apps that don't
 *    scan QRs) and a QR-code data URL ready to drop into an <img> tag.
 *
 * Re-calling this endpoint while 2FA is already enabled is a 409 — we
 * never overwrite a working secret without the user disabling 2FA first.
 */

import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import { generateTotpSecret, buildOtpAuthUrl } from "@/lib/totp";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const admin = getAdminClient();

  // Refuse to re-issue a secret if the user is already enrolled. They must
  // disable first (which itself requires a valid code).
  const { data: existing, error: readError } = await admin
    .from("users")
    .select("totp_enabled")
    .eq("id", user.id)
    .single<{ totp_enabled: boolean | null }>();

  if (readError) {
    console.error("[api/2fa/setup] DB read error:", readError);
    return NextResponse.json({ error: "Failed to start 2FA setup" }, { status: 500 });
  }

  if (existing?.totp_enabled) {
    return NextResponse.json(
      { error: "2fa_already_enabled" },
      { status: 409 }
    );
  }

  const secret = generateTotpSecret();
  const accountLabel = user.email ?? user.id;
  const otpAuthUrl = buildOtpAuthUrl(secret, accountLabel);

  // QR code as a PNG data URL — the dashboard drops this straight into an
  // <img src=...> tag, no extra round-trip required.
  let qrDataUrl: string;
  try {
    qrDataUrl = await QRCode.toDataURL(otpAuthUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240,
    });
  } catch (err) {
    console.error("[api/2fa/setup] QR generation failed:", err);
    return NextResponse.json({ error: "Failed to generate QR" }, { status: 500 });
  }

  // Persist the secret so /api/2fa/verify can read it back. We do NOT set
  // totp_enabled here — that flag only flips after a successful verify.
  const { error: updateError } = await admin
    .from("users")
    .update({ totp_secret: secret, totp_enabled: false, totp_recovery_codes: null })
    .eq("id", user.id);

  if (updateError) {
    console.error("[api/2fa/setup] DB update error:", updateError);
    return NextResponse.json({ error: "Failed to save 2FA secret" }, { status: 500 });
  }

  return NextResponse.json({ secret, qrDataUrl, otpAuthUrl });
}
