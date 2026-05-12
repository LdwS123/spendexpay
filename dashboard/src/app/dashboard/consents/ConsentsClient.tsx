"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useRealtimeTable } from "@/lib/use-realtime-table";
import { RealtimeToastStack, useToasts } from "@/app/dashboard/RealtimeToast";

type ConsentStatus =
  | "pending"
  | "approved"
  | "declined"
  | "expired"
  | "cancelled"
  | string;

export interface ConsentRequestRow {
  id: string;
  user_id: string;
  service: string | null;
  action: string | null;
  amount_usd: number | null;
  context: Record<string, unknown> | null;
  options: string[] | null;
  status: ConsentStatus;
  decision: string | null;
  decision_made_at: string | null;
  expires_at: string | null;
  created_at: string;
}

function serviceLabel(raw: string | null | undefined): string {
  if (!raw) return "—";
  const map: Record<string, string> = {
    vercel: "Vercel",
    modal: "Modal",
    openai: "OpenAI",
    anthropic: "Anthropic",
    railway: "Railway",
    fly: "Fly.io",
    flyio: "Fly.io",
    render: "Render",
    netlify: "Netlify",
    github: "GitHub",
  };
  return map[raw.toLowerCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

function actionPhrase(row: ConsentRequestRow): string {
  const svc = serviceLabel(row.service);
  if (row.action) {
    if (row.amount_usd && row.amount_usd > 0) {
      return `${row.action} (€${row.amount_usd.toFixed(2)}) on ${svc}`;
    }
    return `${row.action} on ${svc}`;
  }
  if (row.amount_usd && row.amount_usd > 0) {
    return `Pay €${row.amount_usd.toFixed(2)} on ${svc}`;
  }
  return `Action on ${svc}`;
}

function expiresInLabel(iso: string | null): string {
  if (!iso) return "no expiry";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "no expiry";
  if (ms <= 0) return "expired";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `expires in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `expires in ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `expires in ${hr} hour${hr === 1 ? "" : "s"}`;
  const day = Math.floor(hr / 24);
  return `expires in ${day} day${day === 1 ? "" : "s"}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }) +
    " · " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

function StatusBadge({ status }: { status: ConsentStatus }) {
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        Pending
      </span>
    );
  }
  if (status === "approved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#00e5b4]/15 text-[#00a882]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#00a882]" />
        Approved
      </span>
    );
  }
  if (status === "declined") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-100">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        Declined
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        Expired
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        Cancelled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-100">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      {status}
    </span>
  );
}

function PendingCard({ row, isNew }: { row: ConsentRequestRow; isNew: boolean }) {
  const ctx = row.context && typeof row.context === "object" ? row.context : null;
  const ctxEntries = ctx
    ? Object.entries(ctx).filter(([, v]) => v !== null && v !== "")
    : [];

  return (
    <div
      className={`bg-white border border-slate-100 rounded-xl p-5 flex flex-col gap-4 hover:border-slate-200 transition-colors ${
        isNew ? "realtime-flash" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <StatusBadge status="pending" />
          <p className="text-sm font-semibold text-[#0a1220] mt-2.5 leading-snug">
            {actionPhrase(row)}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">
            {expiresInLabel(row.expires_at)}
          </p>
        </div>
      </div>

      {ctxEntries.length > 0 && (
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-xs space-y-1">
          {ctxEntries.slice(0, 3).map(([k, v]) => (
            <div key={k} className="flex items-start gap-2">
              <span className="text-slate-400 shrink-0">{k}:</span>
              <span className="text-slate-700 truncate">
                {typeof v === "string" || typeof v === "number"
                  ? String(v)
                  : JSON.stringify(v)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-3 border-t border-slate-100">
        <p className="text-[11px] text-slate-400">
          Requested {formatDateTime(row.created_at)}
        </p>
        <Link
          href={`/dashboard/consents/${row.id}`}
          className="inline-flex items-center gap-1 text-xs font-semibold bg-[#00e5b4] hover:bg-[#00c49a] text-[#070d18] px-3 py-1.5 rounded-lg transition-colors"
        >
          Decide →
        </Link>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white border border-dashed border-slate-200 rounded-2xl p-10 text-center">
      <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center mb-4 mx-auto">
        <svg
          className="w-5 h-5 text-slate-300"
          fill="none"
          viewBox="0 0 16 16"
          stroke="currentColor"
          strokeWidth={1.5}
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path d="M5 8l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <p className="text-sm font-medium text-slate-600">
        No consent requests yet
      </p>
      <p className="text-xs text-slate-400 mt-1.5 max-w-md mx-auto leading-relaxed">
        When your agent needs your input, requests will appear here.
      </p>
    </div>
  );
}

function isPending(row: ConsentRequestRow): boolean {
  if (row.status !== "pending") return false;
  if (!row.expires_at) return true;
  return new Date(row.expires_at).getTime() > Date.now();
}

interface ConsentsClientProps {
  initialPending: ConsentRequestRow[];
  initialHistory: ConsentRequestRow[];
  userId: string;
}

export default function ConsentsClient({
  initialPending,
  initialHistory,
  userId,
}: ConsentsClientProps) {
  const [pending, setPending] = useState<ConsentRequestRow[]>(initialPending);
  const [history, setHistory] = useState<ConsentRequestRow[]>(initialHistory);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const { toasts, push, dismiss } = useToasts();

  const markNew = useCallback((id: string) => {
    setNewIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    window.setTimeout(() => {
      setNewIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 3200);
  }, []);

  const handleInsert = useCallback(
    (row: ConsentRequestRow) => {
      if (isPending(row)) {
        setPending((prev) => {
          if (prev.some((r) => r.id === row.id)) return prev;
          return [row, ...prev];
        });
        push({
          title: `Consent requested: ${actionPhrase(row)}`,
          body: "Your agent is waiting on your decision.",
        });
      } else {
        setHistory((prev) => {
          if (prev.some((r) => r.id === row.id)) return prev;
          return [row, ...prev].slice(0, 100);
        });
      }
      markNew(row.id);
    },
    [markNew, push]
  );

  const handleUpdate = useCallback(
    (row: ConsentRequestRow) => {
      const nowPending = isPending(row);

      if (nowPending) {
        // Update existing pending or move from history.
        setHistory((prev) => prev.filter((r) => r.id !== row.id));
        setPending((prev) => {
          const idx = prev.findIndex((r) => r.id === row.id);
          if (idx === -1) return [row, ...prev];
          const next = prev.slice();
          next[idx] = row;
          return next;
        });
      } else {
        // Moved out of pending → push into history.
        setPending((prev) => prev.filter((r) => r.id !== row.id));
        setHistory((prev) => {
          const idx = prev.findIndex((r) => r.id === row.id);
          if (idx === -1) return [row, ...prev].slice(0, 100);
          const next = prev.slice();
          next[idx] = row;
          return next;
        });
        if (row.status === "approved" || row.status === "declined") {
          push({
            title:
              row.status === "approved"
                ? `Approved: ${actionPhrase(row)}`
                : `Declined: ${actionPhrase(row)}`,
          });
        }
      }
      markNew(row.id);
    },
    [markNew, push]
  );

  useRealtimeTable<ConsentRequestRow>(
    "consent_requests",
    userId,
    handleInsert,
    handleUpdate
  );

  const isEmpty = pending.length === 0 && history.length === 0;

  if (isEmpty) {
    return (
      <>
        <EmptyState />
        <RealtimeToastStack toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  return (
    <>
      {pending.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-[#0a1220]">Pending</h2>
            <span className="text-[11px] text-slate-400 tabular-nums">
              {pending.length} awaiting decision
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {pending.map((row) => (
              <PendingCard key={row.id} row={row} isNew={newIds.has(row.id)} />
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-[#0a1220]">Recent</h2>
          <span className="text-[11px] text-slate-400 tabular-nums">
            Last {history.length}
          </span>
        </div>

        {history.length === 0 ? (
          <div className="bg-white border border-slate-100 rounded-xl px-6 py-10 text-center">
            <p className="text-sm text-slate-500">No past requests.</p>
          </div>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="sm:hidden space-y-2">
              {history.map((row) => (
                <Link
                  key={row.id}
                  href={`/dashboard/consents/${row.id}`}
                  aria-label={`Consent for ${serviceLabel(row.service)}, status ${row.status}, ${formatDateTime(row.created_at)}`}
                  className={`block bg-white border border-slate-100 rounded-xl px-4 py-3 min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5b4] ${
                    newIds.has(row.id) ? "realtime-flash" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[#0a1220] truncate">
                        {serviceLabel(row.service)}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5 truncate">
                        {row.action ?? "—"}
                        {row.amount_usd && row.amount_usd > 0
                          ? ` · €${row.amount_usd.toFixed(2)}`
                          : ""}
                      </p>
                    </div>
                    <div className="shrink-0">
                      <StatusBadge status={row.status} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-50">
                    <span className="text-[11px] text-slate-500">
                      {formatDateTime(row.created_at)}
                    </span>
                    <span className="text-xs font-semibold text-[#00a882]">
                      View →
                    </span>
                  </div>
                </Link>
              ))}
            </div>

            {/* Desktop: table */}
            <div className="hidden sm:block bg-white rounded-xl border border-slate-100 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[420px]">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">
                        Date
                      </th>
                      <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">
                        Service
                      </th>
                      <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 hidden md:table-cell">
                        Action
                      </th>
                      <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">
                        Status
                      </th>
                      <th className="text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide px-5 py-3 hidden lg:table-cell">
                        Decision
                      </th>
                      <th className="text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {history.map((row) => (
                      <tr
                        key={row.id}
                        className={`hover:bg-slate-50/60 transition-colors ${
                          newIds.has(row.id) ? "realtime-flash" : ""
                        }`}
                      >
                        <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap">
                          {formatDateTime(row.created_at)}
                        </td>
                        <td className="px-4 py-3 text-sm text-[#0a1220] font-medium">
                          {serviceLabel(row.service)}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500 hidden md:table-cell">
                          {row.action ?? "—"}
                          {row.amount_usd && row.amount_usd > 0
                            ? ` · €${row.amount_usd.toFixed(2)}`
                            : ""}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="px-5 py-3 text-xs text-slate-500 hidden lg:table-cell">
                          {row.decision ?? "—"}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <Link
                            href={`/dashboard/consents/${row.id}`}
                            className="text-xs font-semibold text-[#00a882] hover:text-[#00e5b4] transition-colors"
                          >
                            View →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      <RealtimeToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
