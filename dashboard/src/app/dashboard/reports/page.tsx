"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReconciliationTx {
  source: "spendex" | "stripe";
  id: string;
  created_at: string;
  service: string | null;
  amount_usd: number;
  status: string;
  description: string | null;
}

interface ReconciliationResponse {
  month: string;
  range: { start: string; end: string };
  spendex_charged: number;
  funding_card_charged: number;
  diff: number;
  has_funding_source: boolean;
  transactions: ReconciliationTx[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentMonthIso(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthOptions(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
    );
  }
  return out;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ReportsPage() {
  const [month, setMonth] = useState<string>(currentMonthIso());
  const [report, setReport] = useState<ReconciliationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [digestState, setDigestState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [digestError, setDigestError] = useState<string | null>(null);

  const months = useMemo(() => monthOptions(), []);

  const loadReport = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/reports/reconciliation?month=${encodeURIComponent(m)}`,
        { credentials: "include" }
      );
      const json = (await res.json()) as
        | ReconciliationResponse
        | { error?: string };
      if (!res.ok) {
        setError(
          (json as { error?: string }).error ?? "Failed to load report."
        );
        setReport(null);
      } else {
        setReport(json as ReconciliationResponse);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReport(month);
  }, [month, loadReport]);

  async function handleSendDigest() {
    setDigestState("sending");
    setDigestError(null);
    try {
      const res = await fetch("/api/digests/weekly", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setDigestState("error");
        setDigestError(json.error ?? "Failed to send digest.");
        return;
      }
      setDigestState("sent");
      setTimeout(() => setDigestState("idle"), 4000);
    } catch (err) {
      setDigestState("error");
      setDigestError(
        err instanceof Error ? err.message : "Network error sending digest."
      );
    }
  }

  const diff = report?.diff ?? 0;
  const hasDiff = report ? Math.abs(diff) > 0.005 : false;

  return (
    <main>
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4">
        <h1 className="text-lg font-semibold text-[#0D0F14]">Reports</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Monthly reconciliation and digests.
        </p>
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-4xl space-y-6">
        {/* ── Reconciliation card ────────────────────────────────────────── */}
        <section className="bg-white rounded-xl border border-slate-100 p-6">
          <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
            <div>
              <h2 className="text-sm font-semibold text-[#0D0F14]">
                Funding-card reconciliation
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Compares your Spendex ledger to the actual charges Stripe billed your card.
              </p>
            </div>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6D5BFF] focus:border-[#6D5BFF]"
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {loading && (
            <p className="text-sm text-slate-400">Loading report…</p>
          )}

          {error && (
            <div className="rounded-lg border border-red-100 bg-red-50/60 p-4">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {report && !loading && !error && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
                <Card
                  label="Spendex says"
                  value={fmtUsd(report.spendex_charged)}
                  hint="audit_logs total"
                />
                <Card
                  label="Funding card charged"
                  value={fmtUsd(report.funding_card_charged)}
                  hint={
                    report.has_funding_source
                      ? "via Stripe"
                      : "no card on file"
                  }
                />
                <Card
                  label="Diff"
                  value={fmtUsd(diff)}
                  tone={hasDiff ? "danger" : "ok"}
                  hint={hasDiff ? "should be 0 or equal to refunds" : "all clear"}
                />
              </div>

              {hasDiff && (
                <div className="rounded-lg border border-red-100 bg-red-50/40 p-4 mb-5">
                  <p className="text-sm text-red-700 mb-1">
                    Spendex says you spent{" "}
                    <strong>{fmtUsd(report.spendex_charged)}</strong>. Your
                    funding card was charged{" "}
                    <strong>{fmtUsd(report.funding_card_charged)}</strong>.
                    Diff: <strong>{fmtUsd(diff)}</strong>.
                  </p>
                  <Link
                    href={`/dashboard/transactions?month=${encodeURIComponent(report.month)}`}
                    className="text-xs font-semibold text-red-700 underline"
                  >
                    Investigate →
                  </Link>
                </div>
              )}

              {report.transactions.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                    Transactions ({report.transactions.length})
                  </h3>
                  <div className="overflow-x-auto -mx-2">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-slate-400 border-b border-slate-100">
                          <th className="py-2 px-2 font-medium">Source</th>
                          <th className="py-2 px-2 font-medium">Date</th>
                          <th className="py-2 px-2 font-medium">Service</th>
                          <th className="py-2 px-2 font-medium">Status</th>
                          <th className="py-2 px-2 font-medium text-right">
                            Amount
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.transactions.map((t) => (
                          <tr
                            key={`${t.source}-${t.id}`}
                            className="border-b border-slate-50 last:border-0"
                          >
                            <td className="py-2 px-2">
                              <span
                                className={
                                  t.source === "spendex"
                                    ? "inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#6D5BFF]/15 text-[#3B82F6]"
                                    : "inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-100 text-violet-700"
                                }
                              >
                                {t.source}
                              </span>
                            </td>
                            <td className="py-2 px-2 text-slate-500">
                              {fmtDate(t.created_at)}
                            </td>
                            <td className="py-2 px-2 text-slate-700 capitalize">
                              {t.service ?? "—"}
                            </td>
                            <td className="py-2 px-2 text-slate-500">
                              {t.status}
                            </td>
                            <td className="py-2 px-2 text-right font-semibold text-slate-700">
                              {fmtUsd(t.amount_usd)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* ── Weekly digest preview ──────────────────────────────────────── */}
        <section className="bg-white rounded-xl border border-slate-100 p-6">
          <h2 className="text-sm font-semibold text-[#0D0F14] mb-1">
            Weekly digest
          </h2>
          <p className="text-xs text-slate-400 mb-4">
            Sent every Monday at 9 UTC. Preview last week&apos;s digest now.
          </p>
          <button
            type="button"
            onClick={handleSendDigest}
            disabled={digestState === "sending"}
            className={`text-sm font-semibold px-4 py-2 rounded-lg transition-colors ${
              digestState === "sent"
                ? "bg-[#6D5BFF]/15 text-[#3B82F6] cursor-default"
                : digestState === "sending"
                  ? "bg-[#6D5BFF]/60 text-[#0D0F14] cursor-not-allowed"
                  : "bg-[#6D5BFF] hover:bg-[#5b48ff] text-[#0D0F14]"
            }`}
          >
            {digestState === "sending"
              ? "Sending…"
              : digestState === "sent"
                ? "Sent — check your inbox"
                : "Send me last week's digest now"}
          </button>
          {digestState === "error" && digestError && (
            <p className="mt-3 text-xs text-red-500">{digestError}</p>
          )}
        </section>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Local card sub-component
// ---------------------------------------------------------------------------

function Card({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "danger";
}) {
  const border =
    tone === "danger"
      ? "border-red-200 bg-red-50/40"
      : tone === "ok"
        ? "border-[#6D5BFF]/40 bg-[#6D5BFF]/10"
        : "border-slate-100 bg-slate-50";
  const valueColor =
    tone === "danger"
      ? "text-red-700"
      : tone === "ok"
        ? "text-[#3B82F6]"
        : "text-[#0D0F14]";
  return (
    <div className={`rounded-lg border ${border} p-4`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">
        {label}
      </div>
      <div className={`text-xl font-bold mt-1 ${valueColor}`}>{value}</div>
      {hint && (
        <div className="text-[11px] text-slate-400 mt-1">{hint}</div>
      )}
    </div>
  );
}
