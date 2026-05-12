"use client";

import { useEffect, useState } from "react";

// ─── Types — must match /api/health response ────────────────────────────────

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

// ─── Visual helpers ─────────────────────────────────────────────────────────

type BadgeTone = "ok" | "degraded" | "down";

function toneFor(status: CheckStatus | EnvStatus): BadgeTone {
  if (status === "ok") return "ok";
  if (status === "missing") return "degraded";
  return "down";
}

function overallTone(status: OverallStatus): BadgeTone {
  return status === "ok" ? "ok" : status === "degraded" ? "degraded" : "down";
}

const TONE_STYLES: Record<BadgeTone, { dot: string; text: string; chip: string }> = {
  ok: {
    dot: "bg-[#00e5b4]",
    text: "text-[#00e5b4]",
    chip: "bg-[#00e5b4]/10 text-[#00e5b4] ring-1 ring-[#00e5b4]/30",
  },
  degraded: {
    dot: "bg-amber-400",
    text: "text-amber-300",
    chip: "bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/30",
  },
  down: {
    dot: "bg-red-500",
    text: "text-red-400",
    chip: "bg-red-500/10 text-red-400 ring-1 ring-red-500/30",
  },
};

function StatusBadge({ tone, label }: { tone: BadgeTone; label: string }) {
  const s = TONE_STYLES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${s.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {label}
    </span>
  );
}

function ServiceCard({
  name,
  status,
  latencyMs,
  detail,
}: {
  name: string;
  status: CheckStatus | EnvStatus;
  latencyMs?: number;
  detail?: string;
}) {
  const tone = toneFor(status);
  const label =
    status === "ok"
      ? "Operational"
      : status === "missing"
        ? "Missing"
        : "Down";
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-6 transition-colors hover:border-white/10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white">{name}</h2>
          {detail ? (
            <p className="mt-1 text-xs text-white/40">{detail}</p>
          ) : null}
        </div>
        <StatusBadge tone={tone} label={label} />
      </div>
      <div className="mt-4 flex items-center justify-between text-xs text-white/40">
        <span>Latency</span>
        <span className="font-mono text-white/70">
          {typeof latencyMs === "number" ? `${latencyMs} ms` : "—"}
        </span>
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function StatusPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchHealth(): Promise<void> {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const json = (await res.json()) as HealthResponse;
        if (cancelled) return;
        setData(json);
        setFetchError(null);
        setLastCheckedAt(new Date());
      } catch (err) {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : "Unknown error");
        setLastCheckedAt(new Date());
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchHealth();
    const id = setInterval(fetchHealth, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const overall: OverallStatus = data?.status ?? (fetchError ? "down" : "ok");
  const tone = overallTone(overall);
  const headline =
    overall === "ok"
      ? "All systems operational"
      : overall === "degraded"
        ? "Partial degradation"
        : "Major outage";

  return (
    <main className="min-h-screen bg-[#070d18] text-white">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-10">
          <p className="text-xs uppercase tracking-widest text-white/40">
            Spendex Pay
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            Spendex Pay system status
          </h1>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <StatusBadge tone={tone} label={headline} />
            <span className="text-xs text-white/40">
              {lastCheckedAt
                ? `Last checked ${lastCheckedAt.toLocaleTimeString()}`
                : loading
                  ? "Checking…"
                  : "—"}
            </span>
          </div>
        </header>

        {fetchError ? (
          <div className="mb-8 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            Failed to reach /api/health: {fetchError}
          </div>
        ) : null}

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ServiceCard
            name="Supabase"
            status={data?.checks.supabase.status ?? "down"}
            latencyMs={data?.checks.supabase.latency_ms}
            detail="Primary database"
          />
          <ServiceCard
            name="Stripe"
            status={data?.checks.stripe.status ?? "down"}
            latencyMs={data?.checks.stripe.latency_ms}
            detail="Payments + Issuing"
          />
          <ServiceCard
            name="Environment"
            status={data?.checks.env.status ?? "missing"}
            detail={
              data && data.checks.env.missing_vars.length > 0
                ? `Missing: ${data.checks.env.missing_vars.join(", ")}`
                : "All required variables set"
            }
          />
        </section>

        <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 text-xs text-white/40">
          <span>
            Version <span className="font-mono text-white/60">{data?.version ?? "—"}</span>
          </span>
          <span>
            Uptime{" "}
            <span className="font-mono text-white/60">
              {typeof data?.uptime_seconds === "number"
                ? `${data.uptime_seconds}s`
                : "—"}
            </span>
          </span>
          <span>Auto-refresh every 30s</span>
        </footer>
      </div>
    </main>
  );
}
