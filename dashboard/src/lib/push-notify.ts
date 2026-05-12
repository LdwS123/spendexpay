/**
 * Server-side helper: send a Web Push notification to a user.
 *
 * Used by /api/notify/consent when the user's notification_channels include
 * "push". This module wraps the `web-push` npm package and centralizes the
 * VAPID configuration so callers only have to provide a payload.
 *
 * Fire-and-forget contract: every error is logged to stderr and swallowed.
 * A failed push must never block email/Telegram dispatch on the parallel
 * track — the user has multiple channels for a reason.
 *
 * ─── Generating VAPID keys ────────────────────────────────────────────────
 * One-time per environment:
 *   npx web-push generate-vapid-keys
 * Set the resulting values in .env.local:
 *   VAPID_PUBLIC_KEY=...
 *   VAPID_PRIVATE_KEY=...
 *   VAPID_SUBJECT=mailto:ops@spendexai.com
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY=<same as VAPID_PUBLIC_KEY>
 * NEXT_PUBLIC_VAPID_PUBLIC_KEY is shipped to the browser; the private key
 * MUST stay server-side only.
 */

import webpush from "web-push";
import { getAdminClient } from "@/lib/supabase";

// ─── VAPID setup ──────────────────────────────────────────────────────────────

/**
 * One-shot VAPID setup. `web-push` complains if `setVapidDetails` is called
 * without all three values, so we lazy-init and remember the result. A
 * missing key isn't fatal at module-load time — it only causes
 * `sendPushToUser` to no-op (with an error log) for the duration of the
 * process.
 */
let vapidConfigured: boolean | null = null;

function ensureVapidConfigured(): boolean {
  if (vapidConfigured !== null) return vapidConfigured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    console.error(
      "[push-notify] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT not set — push notifications disabled."
    );
    vapidConfigured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidConfigured = true;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[push-notify] setVapidDetails failed: ${message}`);
    vapidConfigured = false;
    return false;
  }
}

// ─── Payload shape ────────────────────────────────────────────────────────────

export interface PushPayload {
  title: string;
  body: string;
  action_url: string;
}

/** Shape of the JSON we expect to find at users.push_subscription. */
interface StoredSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

function isStoredSubscription(v: unknown): v is StoredSubscription {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.endpoint !== "string" || o.endpoint.length === 0) return false;
  if (!o.keys || typeof o.keys !== "object") return false;
  const k = o.keys as Record<string, unknown>;
  return typeof k.p256dh === "string" && typeof k.auth === "string";
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SendPushResult {
  ok: boolean;
  reason?: string;
}

/**
 * Look up `users.push_subscription` for the given user and fire a single
 * push notification. Returns a structured result so callers (e.g. the
 * consent-notify dispatcher) can log per-channel outcomes alongside email
 * and Telegram.
 *
 * Never throws — every error is converted to `{ ok: false, reason }`.
 *
 * 410 / 404 responses from the push service mean the browser has revoked
 * the subscription (uninstalled PWA, cleared cookies, etc.). We clear the
 * stale row so the next consent request doesn't waste a network round-trip.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<SendPushResult> {
  if (!ensureVapidConfigured()) {
    return { ok: false, reason: "VAPID keys not configured" };
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[push-notify] admin client error: ${message}`);
    return { ok: false, reason: message };
  }

  const { data, error } = await admin
    .from("users")
    .select("push_subscription")
    .eq("id", userId)
    .maybeSingle<{ push_subscription: unknown }>();

  if (error) {
    if (error.code === "42703") {
      return { ok: false, reason: "push_subscription column not migrated" };
    }
    console.error(
      `[push-notify] supabase error loading subscription for ${userId}: ${error.message}`
    );
    return { ok: false, reason: error.message };
  }

  const sub = data?.push_subscription;
  if (!isStoredSubscription(sub)) {
    return { ok: false, reason: "No push subscription on file for user" };
  }

  const body = JSON.stringify(payload);

  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
      },
      body
    );
    return { ok: true };
  } catch (err) {
    // `web-push` raises a `WebPushError` with a `statusCode` field on HTTP
    // failures from the push service. 404 / 410 = subscription is gone for
    // good; clear it so we stop trying.
    const e = err as { statusCode?: number; message?: string };
    const status = typeof e?.statusCode === "number" ? e.statusCode : undefined;
    const message = e?.message ?? String(err);

    if (status === 404 || status === 410) {
      console.error(
        `[push-notify] subscription gone (${status}) for user=${userId}; clearing.`
      );
      await admin
        .from("users")
        .update({ push_subscription: null })
        .eq("id", userId);
      return { ok: false, reason: `Subscription expired (HTTP ${status})` };
    }

    console.error(
      `[push-notify] sendNotification failed for user=${userId}: ${message}`
    );
    return { ok: false, reason: message };
  }
}
