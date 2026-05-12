"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Amber alert banner shown at the top of the dashboard when the
 * /api/anomalies route reports a fast-decline or velocity anomaly. The
 * banner is purely informational — clicking through does not auto-fix
 * anything; it just deep-links to the relevant detail view.
 *
 * Dismissal is local-only (sessionStorage). We deliberately do NOT mute the
 * banner across sessions: if the anomaly is still happening tomorrow, the
 * user needs to see it tomorrow.
 */

interface AnomalyData {
  fastDeclines: { count: number; avgMs: number };
  velocity: { count: number; threshold: number; isAnomaly: boolean };
  shouldAlert: boolean;
}

const STORAGE_KEY = "spendex:anomaly-banner-dismissed";

export default function AnomalyBanner() {
  const [data, setData] = useState<AnomalyData | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setDismissed(sessionStorage.getItem(STORAGE_KEY) === "1");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/anomalies", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as AnomalyData;
        if (!cancelled) setData(json);
      } catch {
        // Network blip — silently leave the banner hidden. Better to under-
        // surface than to flash a false alarm on a transient failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed) return null;
  if (!data || !data.shouldAlert) return null;

  // Fast-decline message takes priority over velocity because it's the more
  // actionable diagnosis (the user knows their client is misconfigured).
  const showFastDeclines = data.fastDeclines.count >= 5;
  const showVelocity = !showFastDeclines && data.velocity.isAnomaly;

  const message = showFastDeclines
    ? "We detected unusual auto-declines on your account. Likely a buggy client."
    : showVelocity
      ? "Your agent is making lots of charges fast."
      : null;

  const linkHref = showFastDeclines ? "/dashboard/consents" : "/dashboard/transactions";

  if (!message) return null;

  function handleDismiss() {
    if (typeof window !== "undefined") {
      sessionStorage.setItem(STORAGE_KEY, "1");
    }
    setDismissed(true);
  }

  return (
    <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path d="M8 2L14 13H2L8 2z" strokeLinejoin="round" />
            <path d="M8 7v3M8 12h.01" strokeLinecap="round" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-amber-900">{message}</p>
          <p className="text-[11px] text-amber-700/80 mt-0.5">
            {showFastDeclines
              ? `${data.fastDeclines.count} declines in the last hour, average ${data.fastDeclines.avgMs}ms each.`
              : `${data.velocity.count} transactions in the last hour (threshold ${data.velocity.threshold}).`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Link
          href={linkHref}
          className="text-xs font-semibold text-amber-800 hover:text-amber-900"
        >
          {showFastDeclines ? "View →" : "Review →"}
        </Link>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="text-amber-700/60 hover:text-amber-900 text-lg leading-none px-1"
        >
          ×
        </button>
      </div>
    </div>
  );
}
