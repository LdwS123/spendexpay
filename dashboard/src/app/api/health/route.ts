import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VERSION = "0.1.0";
const CHECK_TIMEOUT_MS = 5_000;

// Record process start once at module load so we can report uptime.
const PROCESS_START_MS = Date.now();

const REQUIRED_ENV_VARS = [
  "STRIPE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type CheckStatus = "ok" | "down";
type EnvStatus = "ok" | "missing";
type OverallStatus = "ok" | "degraded" | "down";

interface ServiceCheck {
  status: CheckStatus;
  latency_ms: number;
  error?: string;
}

interface EnvCheck {
  status: EnvStatus;
  missing_vars: string[];
}

interface HealthResponse {
  status: OverallStatus;
  timestamp: string;
  version: string;
  checks: {
    supabase: ServiceCheck;
    stripe: ServiceCheck;
    env: EnvCheck;
  };
  uptime_seconds: number;
}

/**
 * Race a promise against a timeout. The timeout rejects with an Error so the
 * outer try/catch path treats it the same as any other failure.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function checkSupabase(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return {
        status: "down",
        latency_ms: Date.now() - start,
        error: "missing supabase env vars",
      };
    }
    const client = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    // Lightweight probe: ask Supabase to count rows in a tiny table. Using
    // `head: true, count: 'exact'` keeps the payload to a single integer and
    // works even if the table is empty. `users` is expected to exist; if not,
    // any HEAD response (even 404 from PostgREST) still proves the network
    // path is alive — but we treat a *thrown* error as down.
    // The Supabase query builder is a PromiseLike (thenable). We adapt it to a
    // real Promise so the typed timeout helper can race against it.
    const builder = client.from("users").select("id", { head: true, count: "exact" });
    const probe: Promise<{ error: { message?: string } | null }> = Promise.resolve(
      builder as PromiseLike<{ error: { message?: string } | null }>
    );
    const result = await withTimeout(probe, CHECK_TIMEOUT_MS, "supabase");
    if (result.error) {
      // PostgREST returns a structured error. A "relation does not exist"
      // error still means the DB is up and answering, so we accept it.
      const msg = result.error.message ?? "";
      if (/does not exist|not found/i.test(msg)) {
        return { status: "ok", latency_ms: Date.now() - start };
      }
      return {
        status: "down",
        latency_ms: Date.now() - start,
        error: msg,
      };
    }
    return { status: "ok", latency_ms: Date.now() - start };
  } catch (err) {
    return {
      status: "down",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkStripe(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      return {
        status: "down",
        latency_ms: Date.now() - start,
        error: "missing STRIPE_SECRET_KEY",
      };
    }
    const stripe = new Stripe(key, { apiVersion: "2025-02-24.acacia" });
    await withTimeout(stripe.balance.retrieve(), CHECK_TIMEOUT_MS, "stripe");
    return { status: "ok", latency_ms: Date.now() - start };
  } catch (err) {
    return {
      status: "down",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkEnv(): EnvCheck {
  const missing: string[] = [];
  for (const name of REQUIRED_ENV_VARS) {
    const v = process.env[name];
    if (!v || v.trim() === "") missing.push(name);
  }
  return {
    status: missing.length === 0 ? "ok" : "missing",
    missing_vars: missing,
  };
}

function fallbackCheck(reason: string): ServiceCheck {
  return { status: "down", latency_ms: 0, error: reason };
}

export async function GET(): Promise<NextResponse<HealthResponse>> {
  const settled = await Promise.allSettled([checkSupabase(), checkStripe()]);
  const supabase: ServiceCheck =
    settled[0].status === "fulfilled"
      ? settled[0].value
      : fallbackCheck(
          settled[0].reason instanceof Error
            ? settled[0].reason.message
            : String(settled[0].reason)
        );
  const stripe: ServiceCheck =
    settled[1].status === "fulfilled"
      ? settled[1].value
      : fallbackCheck(
          settled[1].reason instanceof Error
            ? settled[1].reason.message
            : String(settled[1].reason)
        );

  const env = checkEnv();

  const failures = [
    supabase.status === "down",
    stripe.status === "down",
    env.status === "missing",
  ].filter(Boolean).length;

  let status: OverallStatus;
  let httpStatus: number;
  if (failures === 0) {
    status = "ok";
    httpStatus = 200;
  } else if (failures >= 3) {
    status = "down";
    httpStatus = 503;
  } else {
    status = "degraded";
    httpStatus = 200;
  }

  const body: HealthResponse = {
    status,
    timestamp: new Date().toISOString(),
    version: VERSION,
    checks: { supabase, stripe, env },
    uptime_seconds: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
  };

  if (status !== "ok") {
    log.warn("health_check_non_ok", {
      status,
      supabase: supabase.status,
      stripe: stripe.status,
      env: env.status,
      missing_vars: env.missing_vars,
    });
  }

  // Cache headers — health must always be fresh.
  return NextResponse.json(body, {
    status: httpStatus,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
