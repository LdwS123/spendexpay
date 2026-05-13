"use client";

import { useMemo, useState } from "react";

// Service icon map — small unicode badge so we don't need to ship logo SVGs
// for every merchant. Falls back to the first letter when a service slug
// isn't recognised. Keep this list in sync with the dashboard merchant list.
const SERVICE_ICONS: Record<string, string> = {
  vercel: "▲",
  netlify: "◆",
  railway: "⚡",
  fly: "✈",
  flyio: "✈",
  render: "◐",
  cloudflare: "☁",
  modal: "◍",
  replicate: "▶",
  huggingface: "🤗",
  openai: "✦",
  anthropic: "✱",
  github: "⌥",
  netflix: "🅽",
  spotify: "♫",
  cursor: "◊",
  gamma: "✶",
  supabase: "⚝",
};

type SubscriptionStatus = "active" | "paused" | "cancelled" | "past_due";
type SubscriptionInterval = "monthly" | "yearly" | "weekly";

export interface SubscriptionRow {
  id: string;
  user_id: string;
  service: string;
  // numeric(10,2) is returned by Supabase as a string to preserve precision.
  amount_usd: number | string | null;
  currency: string | null;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  description: string | null;
  started_at: string;
  next_charge_at: string;
  last_charged_at: string | null;
  cancelled_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

function serviceIcon(service: string): string {
  const key = service.toLowerCase();
  return SERVICE_ICONS[key] ?? service.charAt(0).toUpperCase();
}

function serviceLabel(service: string): string {
  // Title-case the first letter; rest unchanged so e.g. "openai" → "Openai"
  // remains readable. (The MCP server stores the slug we want surfaced.)
  if (!service) return "Unknown";
  return service.charAt(0).toUpperCase() + service.slice(1);
}

function intervalLabel(interval: SubscriptionInterval): string {
  switch (interval) {
    case "monthly":
      return "month";
    case "yearly":
      return "year";
    case "weekly":
      return "week";
  }
}

/**
 * Days remaining until the next renewal. Returns "N days" / "today" /
 * "overdue" depending on the comparison to the current clock. Used in the
 * card body so the user sees a human-friendly cadence rather than a raw ISO
 * timestamp.
 */
function daysUntil(iso: string): string {
  const target = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = target - now;
  if (diffMs <= 0) return "overdue";
  const days = Math.ceil(diffMs / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `${days} days`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) +
    " · " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

function StatusBadge({ status }: { status: SubscriptionStatus }) {
  const map: Record<
    SubscriptionStatus,
    { label: string; cls: string; dot: string }
  > = {
    active: {
      label: "Active",
      cls: "bg-[#6D5BFF]/15 text-[#3B82F6]",
      dot: "bg-[#3B82F6]",
    },
    paused: {
      label: "Paused",
      cls: "bg-amber-50 text-amber-700 border border-amber-100",
      dot: "bg-amber-500",
    },
    cancelled: {
      label: "Cancelled",
      cls: "bg-slate-100 text-slate-500",
      dot: "bg-slate-400",
    },
    past_due: {
      label: "Past due",
      cls: "bg-red-50 text-red-700 border border-red-100",
      dot: "bg-red-500",
    },
  };
  const m = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full ${m.cls}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

interface SubscriptionsClientProps {
  initialSubscriptions: SubscriptionRow[];
}

export default function SubscriptionsClient({
  initialSubscriptions,
}: SubscriptionsClientProps) {
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>(
    initialSubscriptions
  );
  // Track per-row pending mutations so we can disable buttons mid-flight
  // without blocking interaction on other rows.
  const [pending, setPending] = useState<Record<string, "cancel" | "pause" | "resume" | null>>(
    {}
  );
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const active: SubscriptionRow[] = [];
    const paused: SubscriptionRow[] = [];
    const cancelled: SubscriptionRow[] = [];
    const pastDue: SubscriptionRow[] = [];
    for (const s of subscriptions) {
      switch (s.status) {
        case "active":
          active.push(s);
          break;
        case "paused":
          paused.push(s);
          break;
        case "cancelled":
          cancelled.push(s);
          break;
        case "past_due":
          pastDue.push(s);
          break;
      }
    }
    return { active, paused, cancelled, pastDue };
  }, [subscriptions]);

  async function handleCancel(id: string) {
    setPending((p) => ({ ...p, [id]: "cancel" }));
    setError(null);
    try {
      const res = await fetch(`/api/subscriptions/${id}/cancel`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Cancel failed (${res.status})`);
      }
      const body = (await res.json()) as { subscription: SubscriptionRow };
      setSubscriptions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...body.subscription } : s))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setPending((p) => ({ ...p, [id]: null }));
    }
  }

  async function handlePause(id: string, action: "pause" | "resume") {
    setPending((p) => ({ ...p, [id]: action }));
    setError(null);
    try {
      const res = await fetch(`/api/subscriptions/${id}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${action} failed (${res.status})`);
      }
      const body = (await res.json()) as { subscription: SubscriptionRow };
      setSubscriptions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...body.subscription } : s))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setPending((p) => ({ ...p, [id]: null }));
    }
  }

  function SubscriptionCard({ sub }: { sub: SubscriptionRow }) {
    const amount = toNumber(sub.amount_usd);
    const interval = intervalLabel(sub.interval);
    const isPending = pending[sub.id] !== undefined && pending[sub.id] !== null;
    const isCancelled = sub.status === "cancelled";
    const isPaused = sub.status === "paused";

    return (
      <article className="bg-white rounded-xl border border-slate-100 p-5 flex flex-col gap-4">
        <div className="flex items-start gap-4">
          {/* Service icon */}
          <div
            className="w-11 h-11 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center text-lg text-slate-700 shrink-0"
            aria-hidden="true"
          >
            {serviceIcon(sub.service)}
          </div>

          {/* Headline */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-[#0D0F14] truncate">
                {serviceLabel(sub.service)}
              </h3>
              <StatusBadge status={sub.status} />
            </div>
            {sub.description && (
              <p className="text-xs text-slate-500 mt-1 truncate">
                {sub.description}
              </p>
            )}
          </div>

          {/* Amount */}
          <div className="text-right shrink-0">
            <p className="text-base font-semibold text-[#0D0F14] tabular-nums">
              ${amount.toFixed(2)}
            </p>
            <p className="text-[11px] text-slate-400">per {interval}</p>
          </div>
        </div>

        {/* Cadence + actions */}
        <div className="flex items-center justify-between gap-3 pt-3 border-t border-slate-50">
          <div className="min-w-0 text-xs text-slate-500">
            {isCancelled ? (
              <>Cancelled · {formatDateTime(sub.cancelled_at ?? sub.updated_at)}</>
            ) : (
              <>
                Next charge in <span className="font-medium text-[#0D0F14]">{daysUntil(sub.next_charge_at)}</span>
                {" "}· {formatDateTime(sub.next_charge_at)}
              </>
            )}
          </div>

          {!isCancelled && (
            <div className="flex items-center gap-2 shrink-0">
              {isPaused ? (
                <button
                  type="button"
                  onClick={() => handlePause(sub.id, "resume")}
                  disabled={isPending}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  {pending[sub.id] === "resume" ? "Resuming…" : "Resume"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handlePause(sub.id, "pause")}
                  disabled={isPending}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  {pending[sub.id] === "pause" ? "Pausing…" : "Pause for 1 month"}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleCancel(sub.id)}
                disabled={isPending}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-[#0D0F14] text-white hover:bg-[#0D0F14]/90 transition-colors disabled:opacity-50"
              >
                {pending[sub.id] === "cancel" ? "Cancelling…" : "Cancel"}
              </button>
            </div>
          )}
        </div>
      </article>
    );
  }

  function Section({ title, rows }: { title: string; rows: SubscriptionRow[] }) {
    if (rows.length === 0) return null;
    return (
      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide px-1">
          {title} · {rows.length}
        </h2>
        <div className="grid grid-cols-1 gap-3">
          {rows.map((sub) => (
            <SubscriptionCard key={sub.id} sub={sub} />
          ))}
        </div>
      </section>
    );
  }

  // Empty state — first-run users have no subscriptions yet.
  if (subscriptions.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-100 flex flex-col items-center justify-center py-20 text-center">
        <div
          className="w-12 h-12 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center mb-4 text-2xl"
          aria-hidden="true"
        >
          <span role="img" aria-label="recurring">
            ↻
          </span>
        </div>
        <p className="text-sm font-medium text-slate-600">No subscriptions yet</p>
        <p className="text-xs text-slate-400 mt-1 max-w-sm leading-relaxed">
          When your agent signs up to a recurring service (Vercel Pro, Netflix,
          Spotify, …) it shows up here. You can cancel or pause anytime.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700">
          {error}
        </div>
      )}

      <Section title="Active" rows={grouped.active} />
      <Section title="Past due" rows={grouped.pastDue} />
      <Section title="Paused" rows={grouped.paused} />
      <Section title="Cancelled" rows={grouped.cancelled} />
    </div>
  );
}
