"use client";

import { useCallback, useState } from "react";
import { useRealtimeTable } from "@/lib/use-realtime-table";
import { RealtimeToastStack, useToasts } from "@/app/dashboard/RealtimeToast";

interface AuditLogLite {
  id: string;
  created_at: string;
  service: string;
  status: string;
  amount_usd: number | null;
  description?: string | null;
}

function formatEur(amount: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(amount);
}

function serviceName(raw: string): string {
  const map: Record<string, string> = {
    vercel: "Vercel",
    flyio: "Fly.io",
    railway: "Railway",
    render: "Render",
    modal: "Modal GPU",
    netlify: "Netlify",
  };
  return map[raw.toLowerCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

function isThisMonth(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth()
  );
}

interface StatCardProps {
  label: string;
  value: string;
  sub: string;
  pulse?: boolean;
}

function StatCard({ label, value, sub, pulse }: StatCardProps) {
  return (
    <div
      className={`bg-white rounded-xl border border-slate-100 p-5 transition-colors ${
        pulse ? "realtime-flash" : ""
      }`}
    >
      <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wide mb-3">
        {label}
      </p>
      <p className="text-xl sm:text-2xl font-bold text-[#0D0F14] tracking-tight">
        {value}
      </p>
      <p className="text-[11px] text-slate-400 mt-1">{sub}</p>
    </div>
  );
}

interface OverviewLiveStatsProps {
  userId: string;
  initialMonthTotalUsd: number;
  initialMonthTransactionCount: number;
  initialTopService: string | null;
  currentMonth: string;
}

export default function OverviewLiveStats({
  userId,
  initialMonthTotalUsd,
  initialMonthTransactionCount,
  initialTopService,
  currentMonth,
}: OverviewLiveStatsProps) {
  const [monthTotal, setMonthTotal] = useState<number>(initialMonthTotalUsd);
  const [monthCount, setMonthCount] = useState<number>(initialMonthTransactionCount);
  const [topService, setTopService] = useState<string | null>(initialTopService);
  // Track per-service totals to maintain the "top service" computation live.
  // Seeded with the SSR-known top service so live additions stay ranked correctly.
  const [, setByService] = useState<Record<string, number>>(() => {
    if (initialTopService && initialMonthTotalUsd > 0) {
      return { [initialTopService]: initialMonthTotalUsd };
    }
    return {};
  });
  const [pulse, setPulse] = useState<boolean>(false);
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const { toasts, push, dismiss } = useToasts();

  const flash = useCallback(() => {
    setPulse(true);
    window.setTimeout(() => setPulse(false), 3200);
  }, []);

  const applySuccessRow = useCallback(
    (row: AuditLogLite, isInsert: boolean) => {
      if (row.status !== "success") return;
      if (!isThisMonth(row.created_at)) return;
      // Idempotency — UPDATE may fire after INSERT for the same row.
      if (seenIds.has(row.id)) return;

      const amount = row.amount_usd ?? 0;

      setSeenIds((prev) => {
        const next = new Set(prev);
        next.add(row.id);
        return next;
      });

      setMonthTotal((prev) => Math.round((prev + amount) * 100) / 100);
      setMonthCount((prev) => prev + 1);

      if (row.service) {
        setByService((prev) => {
          const next = { ...prev };
          next[row.service] = (next[row.service] ?? 0) + amount;
          // Recompute top service.
          const winner = Object.entries(next).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
          setTopService(winner);
          return next;
        });
      }

      flash();

      if (isInsert && amount > 0) {
        push({
          title: `Your agent just paid ${formatEur(amount)} on ${serviceName(row.service)}`,
          body: row.description ?? undefined,
        });
      }
    },
    [seenIds, flash, push]
  );

  const handleInsert = useCallback(
    (row: AuditLogLite) => applySuccessRow(row, true),
    [applySuccessRow]
  );

  const handleUpdate = useCallback(
    (row: AuditLogLite) => applySuccessRow(row, false),
    [applySuccessRow]
  );

  useRealtimeTable<AuditLogLite>("audit_logs", userId, handleInsert, handleUpdate);

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-7">
        <StatCard
          label="Spent this month"
          value={formatEur(monthTotal)}
          sub={currentMonth}
          pulse={pulse}
        />
        <StatCard
          label="Transactions"
          value={String(monthCount)}
          sub="Successful this month"
          pulse={pulse}
        />
        <StatCard
          label="Top service"
          value={topService ? serviceName(topService) : "—"}
          sub={topService ? "Most spend this month" : "No data yet"}
        />
      </div>
      <RealtimeToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
