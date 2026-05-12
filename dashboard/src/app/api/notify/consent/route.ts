/**
 * POST /api/notify/consent
 *
 * Called by the MCP server immediately after a consent_request row is
 * inserted into Supabase. We fan the notification out to whichever channels
 * the user has configured (email, Telegram, ...).
 *
 * Request body:
 *   { "consent_id": "<uuid>" }
 *
 * Behavior:
 *   1. Load the consent_request row (must exist).
 *   2. Load the user (for email) and user_consent_preferences
 *      (for notification_channels + telegram_chat_id).
 *   3. For each channel listed in preferences.notification_channels:
 *        - "email"    → sendConsentEmail (best-effort)
 *        - "telegram" → sendConsentTelegram (best-effort)
 *      Each channel failure is logged but does not abort the others.
 *   4. Return 200 with per-channel status so the MCP server can record
 *      it in its own audit trail.
 *
 * The MCP server treats this as fire-and-forget: even if every channel
 * fails, the consent request still exists in DB and a user can decide it
 * from the dashboard. We therefore return 200 as long as the request was
 * well-formed and we found the consent row.
 *
 * Security:
 *   Authenticated via a shared secret passed in the `x-internal-token`
 *   header. The MCP server reads the same value from `NOTIFY_INTERNAL_TOKEN`
 *   in its environment and includes it on every request. Compared in
 *   constant time against the dashboard's `NOTIFY_INTERNAL_TOKEN` env var.
 *   Requests without a valid token are rejected with 401 before any
 *   consent_id is looked up, which defeats enumeration and spam.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { sendConsentEmail } from "@/lib/email";
import { sendConsentTelegram } from "@/lib/telegram";
import { sendPushToUser } from "@/lib/push-notify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Supabase admin client (service-role; bypasses RLS)
// ---------------------------------------------------------------------------

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "[notify/consent] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set."
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Row shapes (we read defensively — sibling agent owns the schema)
// ---------------------------------------------------------------------------

interface ConsentRequestRow {
  id: string;
  user_id: string;
  action: string;
  service: string;
  amount_usd: number | null;
  context: string | null;
  options: string[] | null;
  status: string | null;
  expires_at: string | null;
}

interface UserConsentPrefsRow {
  user_id: string;
  notification_channels: string[] | null;
  telegram_chat_id: string | null;
}

interface PerChannelResult {
  channel: string;
  ok: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Shared-secret auth — runs before anything else so that an attacker
  // cannot enumerate consent_ids or spam users' email/Telegram channels.
  const expectedToken = process.env.NOTIFY_INTERNAL_TOKEN;
  if (!expectedToken) {
    console.error("[notify/consent] NOTIFY_INTERNAL_TOKEN not configured");
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }
  const providedToken = req.headers.get("x-internal-token") ?? "";
  const expectedBuf = Buffer.from(expectedToken);
  const providedBuf = Buffer.from(providedToken);
  if (
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: { consent_id?: unknown };
  try {
    payload = (await req.json()) as { consent_id?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const consentId =
    typeof payload.consent_id === "string" ? payload.consent_id : null;
  if (!consentId) {
    return NextResponse.json(
      { error: "Missing or invalid consent_id" },
      { status: 400 }
    );
  }

  let admin: SupabaseClient;
  try {
    admin = getSupabaseAdmin();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify/consent] ${message}`);
    return NextResponse.json(
      { error: "Server not configured" },
      { status: 500 }
    );
  }

  // 1. Load the consent_request row.
  const { data: consent, error: consentErr } = await admin
    .from("consent_requests")
    .select(
      "id, user_id, action, service, amount_usd, context, options, status, expires_at"
    )
    .eq("id", consentId)
    .maybeSingle<ConsentRequestRow>();

  if (consentErr) {
    console.error(
      `[notify/consent] Supabase error loading consent ${consentId}: ${consentErr.message}`
    );
    return NextResponse.json(
      { error: "Failed to load consent request" },
      { status: 500 }
    );
  }
  if (!consent) {
    return NextResponse.json(
      { error: "Consent request not found" },
      { status: 404 }
    );
  }

  // 2a. Load user email via Supabase auth admin API. (Email lives on auth.users,
  //     not in public.users, in default Supabase projects.)
  let userEmail: string | null = null;
  try {
    const { data: userResp, error: userErr } = await admin.auth.admin.getUserById(
      consent.user_id
    );
    if (userErr) {
      console.error(
        `[notify/consent] auth.admin.getUserById error for user ${consent.user_id}: ${userErr.message}`
      );
    } else {
      userEmail = userResp.user?.email ?? null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[notify/consent] Unexpected error fetching user ${consent.user_id}: ${message}`
    );
  }

  // 2b. Load notification preferences. If the row is missing we default to
  //     email-only — the user will still receive a notification, just not on
  //     a channel we don't know about.
  const { data: prefs, error: prefsErr } = await admin
    .from("user_consent_preferences")
    .select("user_id, notification_channels, telegram_chat_id")
    .eq("user_id", consent.user_id)
    .maybeSingle<UserConsentPrefsRow>();

  if (prefsErr) {
    console.error(
      `[notify/consent] Supabase error loading preferences for user ${consent.user_id}: ${prefsErr.message}`
    );
  }

  const channels = prefs?.notification_channels?.length
    ? prefs.notification_channels
    : ["email"];

  // 3. Compute the expiry window so the email can show "expires in N minutes".
  let expiresInMinutes: number | undefined;
  if (consent.expires_at) {
    const ms = new Date(consent.expires_at).getTime() - Date.now();
    if (Number.isFinite(ms) && ms > 0) {
      expiresInMinutes = Math.max(1, Math.round(ms / 60_000));
    }
  }

  const options = Array.isArray(consent.options) ? consent.options : [];
  // Defensive: if the schema didn't populate options, fall back to
  // approve/decline so we still surface *something* the user can act on.
  const effectiveOptions = options.length > 0 ? options : ["approve", "decline"];

  // 4. Dispatch to each requested channel. We run them in parallel because
  //    Resend and Telegram are independent; the user gets the fastest
  //    available channel first.
  const dispatches: Array<Promise<PerChannelResult>> = [];

  for (const channel of channels) {
    if (channel === "email") {
      if (!userEmail) {
        dispatches.push(
          Promise.resolve({
            channel: "email",
            ok: false,
            reason: "No email address on file for user",
          })
        );
        continue;
      }
      dispatches.push(
        sendConsentEmail({
          to: userEmail,
          consentId: consent.id,
          action: consent.action,
          service: consent.service,
          amountUsd: consent.amount_usd ?? undefined,
          context: consent.context ?? "",
          options: effectiveOptions,
          expiresInMinutes,
        })
          .then((): PerChannelResult => ({ channel: "email", ok: true }))
          .catch((err: unknown): PerChannelResult => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[notify/consent] email dispatch threw for ${userEmail}: ${message}`
            );
            return { channel: "email", ok: false, reason: message };
          })
      );
    } else if (channel === "telegram") {
      const chatId = prefs?.telegram_chat_id;
      if (!chatId) {
        dispatches.push(
          Promise.resolve({
            channel: "telegram",
            ok: false,
            reason: "No telegram_chat_id linked",
          })
        );
        continue;
      }
      dispatches.push(
        sendConsentTelegram({
          chatId,
          consentId: consent.id,
          action: consent.action,
          service: consent.service,
          amountUsd: consent.amount_usd ?? undefined,
          context: consent.context ?? "",
          options: effectiveOptions,
        })
          .then((): PerChannelResult => ({ channel: "telegram", ok: true }))
          .catch((err: unknown): PerChannelResult => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[notify/consent] telegram dispatch threw for chat ${chatId}: ${message}`
            );
            return { channel: "telegram", ok: false, reason: message };
          })
      );
    } else if (channel === "push") {
      // Web Push: looked up at send time by sendPushToUser. If no
      // push_subscription is on file the helper returns ok:false with a
      // descriptive reason — no extra work needed here.
      const dashboardBase =
        process.env.SPENDEX_DASHBOARD_URL ??
        process.env.NEXT_PUBLIC_APP_URL ??
        "https://app.spendexai.com";
      const amountText =
        typeof consent.amount_usd === "number"
          ? `$${consent.amount_usd.toFixed(2)}`
          : "an amount";
      dispatches.push(
        sendPushToUser(consent.user_id, {
          title: "Spendex needs your input",
          body: `Your agent wants to pay ${amountText} on ${consent.service}. Tap to review.`,
          action_url: `${dashboardBase.replace(/\/$/, "")}/dashboard/consents/${consent.id}`,
        })
          .then((r): PerChannelResult => ({
            channel: "push",
            ok: r.ok,
            reason: r.reason,
          }))
          .catch((err: unknown): PerChannelResult => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[notify/consent] push dispatch threw for user ${consent.user_id}: ${message}`
            );
            return { channel: "push", ok: false, reason: message };
          })
      );
    } else {
      dispatches.push(
        Promise.resolve({
          channel,
          ok: false,
          reason: `Unknown channel "${channel}"`,
        })
      );
    }
  }

  const results = await Promise.all(dispatches);

  for (const r of results) {
    if (r.ok) {
      console.error(
        `[notify/consent] ${r.channel} OK for consent=${consent.id} user=${consent.user_id}.`
      );
    } else {
      console.error(
        `[notify/consent] ${r.channel} SKIPPED/FAILED for consent=${consent.id} user=${consent.user_id}: ${r.reason ?? "unknown"}.`
      );
    }
  }

  return NextResponse.json(
    {
      ok: true,
      consent_id: consent.id,
      channels: results,
    },
    { status: 200 }
  );
}
