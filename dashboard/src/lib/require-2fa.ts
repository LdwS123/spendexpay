/**
 * 2FA gate for critical routes.
 *
 * Usage:
 *   const gate = await require2FA(userId, req);
 *   if (gate.blocked) return gate.response;
 *
 * Behaviour:
 *   - If the user has not enabled 2FA → returns { blocked: false }. The
 *     route proceeds as if the gate didn't exist. This is graceful: we do
 *     not force every user onto 2FA — they opt in via Settings.
 *   - If the user has 2FA enabled but the request lacks `X-2FA-Code` (or
 *     the code is wrong) → returns 409 Conflict with `{ error: "2fa_required" }`.
 *     The frontend should prompt the user for their code and resubmit
 *     with the header set.
 *   - The header may carry either a 6-digit TOTP code or a recovery code.
 *     Recovery codes are single-use: when one matches we strip it from
 *     the stored array so it can never be replayed.
 *
 * Why 409 instead of 401 or 403?
 *   The user IS authenticated. The action is just gated by an additional
 *   factor. 409 ("Conflict") is the cleanest signal that the *request* is
 *   incomplete — re-send with X-2FA-Code and it succeeds. 401 would imply
 *   "log in again", which is wrong, and 403 would imply "permanently
 *   denied", which is also wrong.
 */

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase";
import {
  verifyTotpCode,
  findRecoveryCodeMatch,
} from "@/lib/totp";

export interface RequireTwoFactorOk {
  blocked: false;
}

export interface RequireTwoFactorBlocked {
  blocked: true;
  response: NextResponse;
}

export type RequireTwoFactorResult = RequireTwoFactorOk | RequireTwoFactorBlocked;

interface TwoFactorUserRow {
  totp_secret: string | null;
  totp_enabled: boolean | null;
  totp_recovery_codes: string[] | null;
}

/**
 * Check whether the request satisfies 2FA for `userId`.
 *
 * `req` may be either a `NextRequest` or a standard `Request` — both expose
 * `.headers.get(name)` which is the only thing we need.
 */
export async function require2FA(
  userId: string,
  req: Request
): Promise<RequireTwoFactorResult> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("totp_secret, totp_enabled, totp_recovery_codes")
    .eq("id", userId)
    .single<TwoFactorUserRow>();

  if (error) {
    console.error("[require2FA] DB read error:", error);
    // Fail closed on DB errors — if we can't tell whether the user has 2FA,
    // we must not silently let the action through.
    return {
      blocked: true,
      response: NextResponse.json(
        { error: "2fa_check_failed" },
        { status: 500 }
      ),
    };
  }

  // Graceful path: no 2FA enabled means the gate is a no-op.
  if (!data?.totp_enabled || !data?.totp_secret) {
    return { blocked: false };
  }

  const code = req.headers.get("x-2fa-code");
  if (!code) {
    return {
      blocked: true,
      response: NextResponse.json(
        { error: "2fa_required" },
        { status: 409 }
      ),
    };
  }

  // Try TOTP first — it's the common path.
  if (verifyTotpCode(code, data.totp_secret)) {
    return { blocked: false };
  }

  // Then try recovery codes. We strip the match so it cannot be reused.
  const stored = data.totp_recovery_codes ?? [];
  const matchIdx = findRecoveryCodeMatch(code, stored);
  if (matchIdx >= 0) {
    const remaining = [...stored.slice(0, matchIdx), ...stored.slice(matchIdx + 1)];
    const { error: updateError } = await admin
      .from("users")
      .update({ totp_recovery_codes: remaining })
      .eq("id", userId);
    if (updateError) {
      console.error("[require2FA] failed to consume recovery code:", updateError);
      // Be conservative: deny the action rather than risk a replay.
      return {
        blocked: true,
        response: NextResponse.json(
          { error: "2fa_check_failed" },
          { status: 500 }
        ),
      };
    }
    return { blocked: false };
  }

  return {
    blocked: true,
    response: NextResponse.json({ error: "2fa_required" }, { status: 409 }),
  };
}
