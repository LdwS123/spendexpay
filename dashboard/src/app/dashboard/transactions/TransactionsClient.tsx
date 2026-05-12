"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { AuditLog } from "@/app/api/transactions/route";
import { useRealtimeTable } from "@/lib/use-realtime-table";
import { RealtimeToastStack, useToasts } from "@/app/dashboard/RealtimeToast";

const FAILED_STATUSES = ["payment_failed", "deploy_failed_after_payment"];

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatDate(iso: string): string {
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

function formatAmount(usd: number): string {
  return "€" + usd.toFixed(2);
}

function serviceLabel(raw: string): string {
  const map: Record<string, string> = {
    vercel: "Vercel",
    modal: "Modal",
    railway: "Railway",
    fly: "Fly.io",
    flyio: "Fly.io",
    render: "Render",
    netlify: "Netlify",
  };
  return map[raw.toLowerCase()] ?? capitalise(raw);
}

function ServiceIcon({ service }: { service: string }) {
  const s = service.toLowerCase();
  if (s === "vercel") {
    return (
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 512 512" aria-hidden="true">
        <path d="M256 48L496 464H16L256 48z" />
      </svg>
    );
  }
  if (s === "modal") {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <path d="M5 8h6M8 5v6" strokeLinecap="round" />
      </svg>
    );
  }
  if (s === "railway") {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (s === "fly" || s === "flyio" || s === "fly.io") {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path d="M3 13L8 3l5 10" strokeLinejoin="round" />
        <path d="M5.5 9h5" strokeLinecap="round" />
      </svg>
    );
  }
  if (s === "render") {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path d="M3 3h10v10H3z" />
        <path d="M6 6l4 4M10 6l-4 4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <rect x="2" y="4" width="12" height="9" rx="1.5" />
      <path d="M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1" />
    </svg>
  );
}

function StatusBadge({ status }: { status: string }) {
  const failed = FAILED_STATUSES.includes(status);
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
        Charged
      </span>
    );
  }
  if (failed) {
    const label = status === "payment_failed" ? "Payment failed" : "Deploy failed";
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-100">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-100">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
      {capitalise(status)}
    </span>
  );
}

function TypeChip({ type }: { type: string | null }) {
  if (!type) return null;
  const label = type.replace(/_/g, "-");
  return (
    <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 uppercase tracking-wide">
      {label}
    </span>
  );
}

function TransactionRow({ tx, isNew }: { tx: AuditLog; isNew: boolean }) {
  return (
    <Link
      href={`/dashboard/transactions/${tx.id}`}
      className={`relative flex items-center gap-4 px-5 py-3.5 border-b border-slate-50 last:border-b-0 hover:bg-slate-50/60 transition-colors cursor-pointer ${
        isNew ? "realtime-flash" : ""
      }`}
    >
      <div className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-500 shrink-0">
        <ServiceIcon service={tx.service} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-[#0a1220]">{capitalise(tx.service)}</span>
          <TypeChip type={tx.transaction_type} />
          {isNew && (
            <span className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#00e5b4]/20 text-[#00a882] uppercase tracking-wide">
              New
            </span>
          )}
        </div>
        {tx.description && (
          <p className="text-xs text-slate-400 mt-0.5 truncate max-w-sm">{tx.description}</p>
        )}
        {tx.error_message && FAILED_STATUSES.includes(tx.status) && (
          <p className="text-xs text-red-400 mt-0.5 truncate max-w-sm">{tx.error_message}</p>
        )}
      </div>
      <div className="shrink-0">
        <StatusBadge status={tx.status} />
      </div>
      <div className="shrink-0 w-20 text-right">
        <span className={`text-sm font-semibold tabular-nums ${tx.status === "success" ? "text-[#0a1220]" : "text-slate-400"}`}>
          {tx.amount_usd != null ? formatAmount(tx.amount_usd) : "—"}
        </span>
      </div>
      <div className="shrink-0 w-40 text-right">
        <span className="text-xs text-slate-400">{formatDate(tx.created_at)}</span>
      </div>
    </Link>
  );
}

interface TransactionsClientProps {
  initialTransactions: AuditLog[];
  userId: string;
  statusFilter: "success" | "failed" | undefined;
}

export default function TransactionsClient({
  initialTransactions,
  userId,
  statusFilter,
}: TransactionsClientProps) {
  const [transactions, setTransactions] = useState<AuditLog[]>(initialTransactions);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const { toasts, push, dismiss } = useToasts();

  // Filter incoming realtime rows to match the current view's status filter.
  const matchesFilter = useCallback(
    (row: AuditLog): boolean => {
      if (!statusFilter) return true;
      if (statusFilter === "success") return row.status === "success";
      return FAILED_STATUSES.includes(row.status);
    },
    [statusFilter]
  );

  const handleInsert = useCallback(
    (row: AuditLog) => {
      if (!matchesFilter(row)) return;

      setTransactions((prev) => {
        if (prev.some((t) => t.id === row.id)) return prev;
        return [row, ...prev].slice(0, 100);
      });

      setNewIds((prev) => {
        const next = new Set(prev);
        next.add(row.id);
        return next;
      });

      // Fade the "new" marker after 3s.
      window.setTimeout(() => {
        setNewIds((prev) => {
          if (!prev.has(row.id)) return prev;
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
      }, 3200);

      // Toast on successful charges only.
      if (row.status === "success" && row.amount_usd != null) {
        push({
          title: `Your agent just paid ${formatAmount(row.amount_usd)} on ${serviceLabel(row.service)}`,
          body: row.description ?? undefined,
        });
      }
    },
    [matchesFilter, push]
  );

  const handleUpdate = useCallback(
    (row: AuditLog) => {
      setTransactions((prev) => {
        const idx = prev.findIndex((t) => t.id === row.id);
        if (idx === -1) {
          // Row entered our filter via an update.
          if (matchesFilter(row)) return [row, ...prev].slice(0, 100);
          return prev;
        }
        const next = prev.slice();
        next[idx] = row;
        return next;
      });
    },
    [matchesFilter]
  );

  useRealtimeTable<AuditLog>("audit_logs", userId, handleInsert, handleUpdate);

  const headerRow = useMemo(
    () => (
      <div className="flex items-center gap-4 px-5 py-2.5 border-b border-slate-100 bg-slate-50/50">
        <div className="w-8 shrink-0" />
        <div className="flex-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
          Service
        </div>
        <div className="shrink-0 w-28 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
          Status
        </div>
        <div className="shrink-0 w-20 text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
          Amount
        </div>
        <div className="shrink-0 w-40 text-right text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
          Date
        </div>
      </div>
    ),
    []
  );

  if (transactions.length === 0) {
    // When a filter is active, we keep the original light empty state — the
    // user already has transactions, they just don't match this filter.
    if (statusFilter) {
      return (
        <>
          <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center mb-4">
                <svg
                  className="w-5 h-5 text-slate-300"
                  fill="none"
                  viewBox="0 0 16 16"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <path d="M3 2h10v12l-2-1.5-2 1.5-2-1.5L5 14 3 14V2z" strokeLinejoin="round" />
                  <line x1="5.5" y1="6" x2="10.5" y2="6" />
                  <line x1="5.5" y1="9" x2="8.5" y2="9" />
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-600">
                No {statusFilter} transactions
              </p>
              <p className="text-xs text-slate-400 mt-1 max-w-xs leading-relaxed">
                Try a different filter to see other transactions.
              </p>
            </div>
          </div>
          <RealtimeToastStack toasts={toasts} onDismiss={dismiss} />
        </>
      );
    }

    // No filter + no transactions ever → big onboarding empty state.
    return (
      <>
        <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="text-5xl mb-4" aria-hidden="true">
              📊
            </div>
            <p className="text-base font-semibold text-[#0a1220]">
              No transactions yet
            </p>
            <p className="text-sm text-slate-500 mt-1.5 max-w-sm leading-relaxed">
              When your agent makes a payment, it&apos;ll appear here in real
              time.
            </p>

            {/* Install snippet — same visual language as the Overview page. */}
            <div className="mt-6 w-full max-w-md rounded-lg bg-[#070d18] px-4 py-3 text-left">
              <pre className="font-mono text-[13px] leading-relaxed text-white whitespace-pre-wrap break-all">
                <span className="text-[#00e5b4]">$</span> claude mcp add spendex
              </pre>
            </div>

            <Link
              href="/docs"
              className="inline-flex items-center gap-1 mt-5 text-xs font-semibold text-[#00c49a] hover:text-[#00a882] transition-colors"
            >
              View install docs →
            </Link>
          </div>
        </div>
        <RealtimeToastStack toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  return (
    <>
      <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
        {headerRow}
        {transactions.map((tx) => (
          <TransactionRow key={tx.id} tx={tx} isNew={newIds.has(tx.id)} />
        ))}
      </div>
      <RealtimeToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
