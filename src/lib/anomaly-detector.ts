/**
 * Anomaly detection for Spendex Pay activity.
 *
 * Forensic insight (V2 §5.8 / §5.10):
 *
 *   When a real user is shown a consent dialog and they're thinking, the
 *   round-trip from `created_at` → `decision_made_at` typically takes tens
 *   of seconds. When a buggy MCP client auto-declines every prompt the
 *   round-trip is effectively zero (we've seen <100ms in production).
 *   That gap is observable in `consent_requests` and is the primary signal
 *   this module surfaces.
 *
 * Two more anomaly classes ride on the same module:
 *   - velocity   — N transactions in a short window (10+ tx/h is the default
 *                   threshold), suggesting a runaway agent loop.
 *   - amount     — a single charge >= 10× the user's running average. Catches
 *                   typos and units-of-currency mistakes (e.g. cents-vs-dollars).
 *
 * Every function below is read-only: we query Supabase and return numbers.
 * Nothing here moves money or mutates state. Callers (the `check_anomalies`
 * MCP tool and the dashboard banner) decide what to do with the signal.
 *
 * All return shapes are strict — no `any`. Anything we read from the DB is
 * coerced through a narrow `Raw…Row` shape before crossing the API boundary.
 */

import { supabase } from "./db.js";

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

export interface FastDeclineStats {
  /** How many consent_requests rows transitioned pending → declined in <1s. */
  count: number;
  /** Average ms between created_at and decision_made_at for those rows. */
  avgMs: number;
}

export interface AmountOutlierResult {
  /** True when the proposed amount is >= 10× the user's running average. */
  isOutlier: boolean;
  /** Mean of successful charges in the lookback window. 0 when no history. */
  avgAmount: number;
  /** amount / avgAmount, or 0 when avgAmount is 0. Cap surfaced verbatim. */
  multiplier: number;
}

// ---------------------------------------------------------------------------
// Internal row shapes — narrow types for the only columns we read.
// ---------------------------------------------------------------------------

interface RawConsentDecisionRow {
  created_at: string;
  decision_made_at: string | null;
  status: string;
}

interface RawAuditAmountRow {
  amount_usd: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decide threshold for "fast" decline. 1000ms = 1s. A human cannot read a
 * consent prompt, decide, and submit a click in under a second; anything
 * faster is necessarily an automated decline.
 */
const FAST_DECLINE_THRESHOLD_MS = 1000;

/** Default lookback for amount-outlier averaging. Two weeks captures a stable
 * baseline without dragging in stale numbers from months-old behaviour. */
const AMOUNT_LOOKBACK_DAYS = 14;

/** Multiplier above the running average that flips a charge to "outlier". */
const AMOUNT_OUTLIER_MULTIPLIER = 10;

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count consent_requests rows for this user where the user "decided" in
 * under 1 second and the decision was "declined". The 1s floor is the
 * threshold below which we treat the decision as machine-generated.
 *
 * Returns `{ count: 0, avgMs: 0 }` on DB error so the caller can show a
 * "no anomalies" banner rather than a 500. Errors are logged to stderr.
 */
export async function detectFastDeclines(
  userId: string,
  windowMin = 60
): Promise<FastDeclineStats> {
  const sinceIso = isoMinutesAgo(windowMin);

  const { data, error } = await supabase
    .from("consent_requests")
    .select("created_at, decision_made_at, status")
    .eq("user_id", userId)
    .eq("status", "declined")
    .gte("created_at", sinceIso)
    .not("decision_made_at", "is", null);

  if (error) {
    console.error(
      `[anomaly] detectFastDeclines: query failed for user ${userId}: ` +
      `${error.message} (code: ${error.code}).`
    );
    return { count: 0, avgMs: 0 };
  }

  const rows = (data ?? []) as RawConsentDecisionRow[];
  let count = 0;
  let totalMs = 0;
  for (const row of rows) {
    if (row.decision_made_at === null) continue;
    const elapsed =
      new Date(row.decision_made_at).getTime() -
      new Date(row.created_at).getTime();
    // Negative elapsed = clock skew between client and DB. Skip rather than
    // pretend we saw an even faster decline; the signal we want is "near zero
    // from above", not "anything weird".
    if (elapsed < 0) continue;
    if (elapsed > FAST_DECLINE_THRESHOLD_MS) continue;
    count += 1;
    totalMs += elapsed;
  }

  return {
    count,
    avgMs: count === 0 ? 0 : Math.round(totalMs / count),
  };
}

/**
 * Count successful or attempted audit_log rows for this user in the window.
 * Flag as anomaly when the count reaches `threshold` (default 10/h).
 *
 * We count every row regardless of status — a payment that was approved and
 * one that was declined both consume Stripe Issuing authorization budget and
 * both indicate the agent is making decisions too quickly. The dashboard
 * surfaces this as "Your agent is making lots of charges fast."
 */
export async function detectVelocityAnomaly(
  userId: string,
  windowMin = 60,
  threshold = 10
): Promise<boolean> {
  const sinceIso = isoMinutesAgo(windowMin);

  const { count, error } = await supabase
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", sinceIso);

  if (error) {
    console.error(
      `[anomaly] detectVelocityAnomaly: query failed for user ${userId}: ` +
      `${error.message} (code: ${error.code}).`
    );
    return false;
  }

  return (count ?? 0) >= threshold;
}

/**
 * Compute the running average charge for this user over the last
 * `AMOUNT_LOOKBACK_DAYS` and decide if `amount` is >= 10× that mean.
 *
 * Only `status = "success"` rows count toward the average — failed charges
 * don't reflect what the user actually spends, and including them would let
 * an attacker poison the baseline with cheap declined attempts before
 * sneaking through one big charge.
 *
 * When the user has zero successful history in the window, we treat the
 * very first charge as non-outlier (`isOutlier: false`). A 10× rule has
 * no meaning without a baseline; surfacing it would just produce a banner
 * on every new user's first transaction.
 */
export async function detectAmountOutlier(
  userId: string,
  amount: number
): Promise<AmountOutlierResult> {
  const sinceIso = isoDaysAgo(AMOUNT_LOOKBACK_DAYS);

  const { data, error } = await supabase
    .from("audit_logs")
    .select("amount_usd, created_at")
    .eq("user_id", userId)
    .eq("status", "success")
    .gte("created_at", sinceIso);

  if (error) {
    console.error(
      `[anomaly] detectAmountOutlier: query failed for user ${userId}: ` +
      `${error.message} (code: ${error.code}).`
    );
    return { isOutlier: false, avgAmount: 0, multiplier: 0 };
  }

  const rows = (data ?? []) as RawAuditAmountRow[];
  let total = 0;
  let n = 0;
  for (const row of rows) {
    if (row.amount_usd === null) continue;
    if (row.amount_usd <= 0) continue;
    total += row.amount_usd;
    n += 1;
  }

  if (n === 0) {
    return { isOutlier: false, avgAmount: 0, multiplier: 0 };
  }

  const avgAmount = total / n;
  const multiplier = avgAmount > 0 ? amount / avgAmount : 0;
  return {
    isOutlier: multiplier >= AMOUNT_OUTLIER_MULTIPLIER,
    avgAmount: Math.round(avgAmount * 100) / 100,
    multiplier: Math.round(multiplier * 100) / 100,
  };
}
