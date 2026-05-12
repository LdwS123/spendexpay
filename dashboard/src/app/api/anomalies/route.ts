/**
 * GET /api/anomalies
 *
 * Auth: server-side Supabase session (no client-supplied user identifiers).
 * Returns the three anomaly checks the dashboard banner consumes plus a
 * `shouldAlert` flag. The route does its own DB work rather than importing
 * `src/lib/anomaly-detector` to avoid pulling MCP-server-only deps (config
 * validation, Stripe SDK, etc.) into the Next.js app — the heuristics are
 * intentionally simple SQL and re-stating them here keeps the two apps
 * decoupled.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export interface AnomaliesResponse {
  fastDeclines: { count: number; avgMs: number };
  velocity: { count: number; threshold: number; isAnomaly: boolean };
  shouldAlert: boolean;
}

interface RawConsentDecisionRow {
  created_at: string;
  decision_made_at: string | null;
}

const FAST_DECLINE_THRESHOLD_MS = 1000;
const FAST_DECLINE_ALERT_FLOOR = 5;
const VELOCITY_THRESHOLD = 10;
const WINDOW_MIN = 60;

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  const userId = user.id;

  let client: ReturnType<typeof getAdminClient>;
  try {
    client = getAdminClient();
  } catch (err) {
    // Dev mode without real Supabase — pretend everything is fine so the
    // dashboard renders. The banner would also pretend; consistent.
    console.error("[api/anomalies] admin client unavailable:", err);
    return NextResponse.json(
      {
        fastDeclines: { count: 0, avgMs: 0 },
        velocity: { count: 0, threshold: VELOCITY_THRESHOLD, isAnomaly: false },
        shouldAlert: false,
      } satisfies AnomaliesResponse,
      { status: 200 }
    );
  }

  const sinceIso = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();

  // Run both queries in parallel — they share nothing and both must finish
  // before we can compute the banner state.
  const [declinesResp, velocityResp] = await Promise.all([
    client
      .from("consent_requests")
      .select("created_at, decision_made_at")
      .eq("user_id", userId)
      .eq("status", "declined")
      .gte("created_at", sinceIso)
      .not("decision_made_at", "is", null),
    client
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", sinceIso),
  ]);

  let fastCount = 0;
  let fastTotalMs = 0;
  // We gracefully degrade rather than 500 — the banner is a soft signal,
  // not a security control. Missing table (42P01) is the most common cause
  // on fresh Supabase projects.
  if (
    declinesResp.error &&
    declinesResp.error.code !== "42P01" &&
    declinesResp.error.code !== "PGRST116"
  ) {
    console.error("[api/anomalies] consent query error:", declinesResp.error);
  } else if (declinesResp.data) {
    const rows = declinesResp.data as RawConsentDecisionRow[];
    for (const row of rows) {
      if (row.decision_made_at === null) continue;
      const elapsed =
        new Date(row.decision_made_at).getTime() -
        new Date(row.created_at).getTime();
      if (elapsed < 0) continue;
      if (elapsed > FAST_DECLINE_THRESHOLD_MS) continue;
      fastCount += 1;
      fastTotalMs += elapsed;
    }
  }

  const velocityCount =
    velocityResp.error && velocityResp.error.code !== "42P01"
      ? 0
      : (velocityResp.count ?? 0);

  if (velocityResp.error && velocityResp.error.code !== "42P01") {
    console.error("[api/anomalies] velocity query error:", velocityResp.error);
  }

  const fastDeclines = {
    count: fastCount,
    avgMs: fastCount === 0 ? 0 : Math.round(fastTotalMs / fastCount),
  };
  const velocity = {
    count: velocityCount,
    threshold: VELOCITY_THRESHOLD,
    isAnomaly: velocityCount >= VELOCITY_THRESHOLD,
  };
  const shouldAlert =
    fastDeclines.count >= FAST_DECLINE_ALERT_FLOOR || velocity.isAnomaly;

  const response: AnomaliesResponse = {
    fastDeclines,
    velocity,
    shouldAlert,
  };
  return NextResponse.json(response, { status: 200 });
}
