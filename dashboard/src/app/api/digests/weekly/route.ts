/**
 * POST /api/digests/weekly
 *
 * Triggers the weekly digest email run. Designed for two callers:
 *
 *   1. An external cron (Vercel Cron, GitHub Actions, manual curl) that
 *      authenticates with either:
 *        - `X-Internal-Token: ${NOTIFY_INTERNAL_TOKEN}` (preferred)
 *        - `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron auto-sets this)
 *
 *   2. The dashboard "Send me last week's digest now" button, which calls
 *      this route via the user's authenticated session. In that case the
 *      route only sends a digest for the calling user (it does not fan out).
 *
 * Request body (optional, JSON):
 *   { "user_id": "<uuid>", "week_start": "2026-05-04" }
 *
 * If `user_id` is omitted we fan out to all "active" users — users with at
 * least one row in audit_logs in the last 30 days. We deliberately don't
 * include every signup ever; that would mean weekly emails to dormant
 * accounts and would torch our Resend reputation.
 *
 * Idempotency:
 *   We track sent digests in the `digest_runs` table:
 *     (user_id, week_start) UNIQUE
 *   Before sending we INSERT a row. If the insert conflicts (row already
 *   exists), we skip this user. This makes the cron safely retryable —
 *   re-running an hour later won't double-send.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import {
  buildWeeklyDigest,
  getStartOfPreviousIsoWeek,
} from "@/lib/digest-builder";
import { sendWeeklyDigest } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Compare two equal-length strings in constant time. Returns false when
 * lengths differ to avoid trivial early-exit timing leaks. Both inputs must
 * be derived from server env vars or HTTP headers — we never hash them.
 */
function constantTimeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify either a NOTIFY_INTERNAL_TOKEN header or a Vercel Cron bearer
 * token. Returns true iff at least one matches a configured secret.
 */
function isAuthorizedAsCron(req: NextRequest): boolean {
  const internalExpected = process.env.NOTIFY_INTERNAL_TOKEN;
  const internalProvided = req.headers.get("x-internal-token");
  if (internalExpected && internalProvided) {
    if (constantTimeEq(internalExpected, internalProvided)) return true;
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (cronSecret && authHeader?.startsWith("Bearer ")) {
    const provided = authHeader.slice("Bearer ".length);
    if (constantTimeEq(cronSecret, provided)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Supabase admin
// ---------------------------------------------------------------------------

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "[digests/weekly] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set."
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Per-user dispatch
// ---------------------------------------------------------------------------

interface DispatchResult {
  user_id: string;
  ok: boolean;
  reason?: string;
}

/**
 * Build and send a digest for a single user. Encapsulates the idempotency
 * guard so callers can run this in parallel without coordinating locks.
 *
 * Order of operations:
 *   1. Reserve the (user, week) slot in digest_runs. If insert fails with
 *      duplicate-key, another run already sent this digest → skip.
 *   2. Load the user's email from auth.users.
 *   3. Build the aggregation.
 *   4. Send the email via Resend.
 *   5. Update the digest_runs row with the result.
 *
 * If step 4 fails we mark the row as failed but do NOT delete it — that
 * way a retry will hit the unique constraint and skip rather than email
 * the user twice with slightly different stats.
 */
async function dispatchForUser(
  admin: SupabaseClient,
  userId: string,
  weekStart: Date
): Promise<DispatchResult> {
  const weekStartIso = weekStart.toISOString().slice(0, 10); // date-only for unique key

  // 1. Idempotency reservation
  const { error: reserveErr } = await admin.from("digest_runs").insert({
    user_id: userId,
    week_start: weekStartIso,
    status: "pending",
  });
  if (reserveErr) {
    // 23505 = unique_violation. We treat ANY error here that looks like a
    // duplicate as "already sent" and skip; a different error logs and skips.
    const code = (reserveErr as { code?: string }).code;
    if (code === "23505") {
      return { user_id: userId, ok: false, reason: "already-sent-this-week" };
    }
    console.error(
      `[digests/weekly] digest_runs insert error for ${userId}: ${reserveErr.message}`
    );
    return {
      user_id: userId,
      ok: false,
      reason: `reserve-failed: ${reserveErr.message}`,
    };
  }

  // 2. Resolve email
  let email: string | null = null;
  let displayName: string | undefined;
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) {
      console.error(
        `[digests/weekly] auth.admin.getUserById failed for ${userId}: ${error.message}`
      );
    } else {
      email = data.user?.email ?? null;
      const meta = (data.user?.user_metadata ?? {}) as {
        display_name?: string;
        full_name?: string;
      };
      displayName = meta.display_name ?? meta.full_name;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[digests/weekly] Unexpected error reading user ${userId}: ${message}`
    );
  }

  if (!email) {
    await markRun(admin, userId, weekStartIso, "skipped", "no-email-on-file");
    return { user_id: userId, ok: false, reason: "no-email-on-file" };
  }

  // 3. Build digest
  let digest;
  try {
    digest = await buildWeeklyDigest(admin, userId, weekStart);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRun(admin, userId, weekStartIso, "failed", message);
    return { user_id: userId, ok: false, reason: `build-failed: ${message}` };
  }

  // Skip empty weeks — no spend, no declines, no point sending an email.
  if (digest.transaction_count === 0 && digest.declined_count === 0) {
    await markRun(admin, userId, weekStartIso, "skipped", "no-activity");
    return { user_id: userId, ok: false, reason: "no-activity" };
  }

  // 4. Send email
  const send = await sendWeeklyDigest({
    to: email,
    displayName,
    weekStart: digest.week_start,
    weekEnd: digest.week_end,
    totalSpentUsd: digest.total_spent_usd,
    transactionCount: digest.transaction_count,
    declinedCount: digest.declined_count,
    successRatePct: digest.success_rate_pct,
    largestCharge: digest.largest_charge
      ? {
          service: digest.largest_charge.service,
          amount_usd: digest.largest_charge.amount_usd,
        }
      : null,
    topServices: digest.top_3_services,
    recentTransactions: digest.recent_transactions,
    vsLastWeek: digest.vs_last_week,
  });

  if (!send.ok) {
    await markRun(admin, userId, weekStartIso, "failed", send.reason ?? "send-failed");
    return {
      user_id: userId,
      ok: false,
      reason: `send-failed: ${send.reason ?? "unknown"}`,
    };
  }

  await markRun(admin, userId, weekStartIso, "sent", null);
  return { user_id: userId, ok: true };
}

async function markRun(
  admin: SupabaseClient,
  userId: string,
  weekStartIso: string,
  status: "sent" | "failed" | "skipped",
  errorMessage: string | null
): Promise<void> {
  const { error } = await admin
    .from("digest_runs")
    .update({
      status,
      error_message: errorMessage,
      sent_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("week_start", weekStartIso);
  if (error) {
    console.error(
      `[digests/weekly] Failed to update digest_runs for ${userId}: ${error.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Active users discovery
// ---------------------------------------------------------------------------

/**
 * Find users with any audit_logs activity in the last 30 days. We use this
 * to avoid sending digests to dormant accounts. A separate maintenance job
 * (not part of this route) re-engages dormant accounts on a different
 * cadence.
 */
async function listActiveUserIds(admin: SupabaseClient): Promise<string[]> {
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data, error } = await admin
    .from("audit_logs")
    .select("user_id")
    .gte("created_at", thirtyDaysAgo);
  if (error) {
    throw new Error(`Failed to list active users: ${error.message}`);
  }
  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ user_id: string | null }>) {
    if (row.user_id) seen.add(row.user_id);
  }
  return Array.from(seen);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  let payload: { user_id?: unknown; week_start?: unknown } = {};
  try {
    // The body is optional — Vercel Cron sends none.
    const text = await req.text();
    if (text) payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requestedUserId =
    typeof payload.user_id === "string" ? payload.user_id : null;
  const requestedWeekStartRaw =
    typeof payload.week_start === "string" ? payload.week_start : null;

  // Two auth paths:
  //   - cron (NOTIFY_INTERNAL_TOKEN or CRON_SECRET) → may target any user
  //   - logged-in user session → may only target themselves
  const isCron = isAuthorizedAsCron(req);

  let admin: SupabaseClient;
  try {
    admin = getSupabaseAdmin();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[digests/weekly] ${message}`);
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  let targetUserIds: string[];
  if (isCron) {
    if (requestedUserId) {
      targetUserIds = [requestedUserId];
    } else {
      try {
        targetUserIds = await listActiveUserIds(admin);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }
  } else {
    // Fall back to user session — limits scope to the calling user only.
    const server = await createServerClient();
    const {
      data: { user },
    } = await server.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    targetUserIds = [user.id];
  }

  // Week resolution: explicit override > previous ISO week (Monday 00:00 UTC)
  let weekStart: Date;
  if (requestedWeekStartRaw) {
    const parsed = new Date(requestedWeekStartRaw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: "Invalid week_start (expected ISO date)" },
        { status: 400 }
      );
    }
    weekStart = parsed;
  } else {
    weekStart = getStartOfPreviousIsoWeek(new Date());
  }

  // Dispatch in parallel — capped to a small concurrency in case the active
  // list is large. Resend can handle a few hundred req/s easily, but we
  // don't want a burst of 10k concurrent fetches if/when we grow.
  const results: DispatchResult[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < targetUserIds.length; i += CONCURRENCY) {
    const slice = targetUserIds.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(
      slice.map((uid) =>
        dispatchForUser(admin, uid, weekStart).catch(
          (err): DispatchResult => ({
            user_id: uid,
            ok: false,
            reason:
              err instanceof Error ? err.message : `unexpected: ${String(err)}`,
          })
        )
      )
    );
    results.push(...batch);
  }

  const sent = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => !r.ok).length;

  return NextResponse.json(
    {
      ok: true,
      week_start: weekStart.toISOString(),
      considered: targetUserIds.length,
      sent,
      skipped,
      results,
    },
    { status: 200 }
  );
}
