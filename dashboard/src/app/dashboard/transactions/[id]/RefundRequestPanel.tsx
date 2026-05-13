"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * RefundRequestPanel — client island for the transaction detail page.
 *
 * Renders one of three states:
 *   1. existing refund request already on file → a badge + link
 *   2. eligible (success, < 30 days, no prior request) → "Request refund"
 *      button that opens a modal
 *   3. otherwise → nothing at all
 *
 * The parent server component does the eligibility math (status + age) and
 * passes `eligible`. The existing-request data is loaded here via a single
 * GET /api/refunds call so the page stays a server component and we don't
 * have to thread a DB read for an optional feature through every render.
 */

type RefundStatus =
  | "pending"
  | "approved"
  | "declined"
  | "refunded"
  | "partial_refund";

interface ExistingRefund {
  id: string;
  status: RefundStatus;
  reason: string;
  created_at: string;
  refunded_amount_usd: number | null;
}

interface Props {
  auditLogId: string;
  eligible: boolean;
}

const REASONS: { value: string; label: string; help: string }[] = [
  {
    value: "not_authorized",
    label: "I didn't authorize this charge",
    help: "Use this if your agent ran without your consent.",
  },
  {
    value: "wrong_amount",
    label: "The amount is wrong",
    help: "You were charged more than expected.",
  },
  {
    value: "duplicate",
    label: "Duplicate charge",
    help: "You see two identical charges close together.",
  },
  {
    value: "not_received",
    label: "I didn't receive the service",
    help: "The deploy / subscription never actually happened.",
  },
  {
    value: "cancelled",
    label: "I cancelled but was still charged",
    help: "You cancelled the subscription / order before this charge.",
  },
];

function badgeClasses(status: RefundStatus): string {
  switch (status) {
    case "refunded":
      return "bg-emerald-50 text-emerald-700 border-emerald-100";
    case "partial_refund":
      return "bg-emerald-50 text-emerald-700 border-emerald-100";
    case "approved":
      return "bg-sky-50 text-sky-700 border-sky-100";
    case "pending":
      return "bg-amber-50 text-amber-700 border-amber-100";
    case "declined":
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

function statusLabel(status: RefundStatus): string {
  switch (status) {
    case "pending":
      return "Refund: pending";
    case "approved":
      return "Refund: approved";
    case "refunded":
      return "Refund: refunded";
    case "partial_refund":
      return "Refund: partial";
    case "declined":
      return "Refund: declined";
  }
}

export default function RefundRequestPanel({ auditLogId, eligible }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState<ExistingRefund | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [explanation, setExplanation] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    void (async () => {
      try {
        const res = await fetch("/api/refunds", { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled.current) setExisting(null);
          return;
        }
        const json: {
          active?: ExistingRefund[] & { audit_log_id: string | null }[];
          history?: ExistingRefund[] & { audit_log_id: string | null }[];
        } = await res.json();
        const pool = [...(json.active ?? []), ...(json.history ?? [])] as Array<
          ExistingRefund & { audit_log_id: string | null }
        >;
        const match = pool.find((r) => r.audit_log_id === auditLogId) ?? null;
        if (!cancelled.current) setExisting(match);
      } catch {
        if (!cancelled.current) setExisting(null);
      } finally {
        if (!cancelled.current) setLoading(false);
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, [auditLogId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) {
      setSubmitError("Please pick a reason.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audit_log_id: auditLogId,
          reason,
          user_explanation: explanation.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setSubmitError(json.error ?? "Something went wrong. Try again.");
        setSubmitting(false);
        return;
      }
      setOpen(false);
      setReason("");
      setExplanation("");
      router.refresh();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Network error. Try again."
      );
      setSubmitting(false);
    }
  }

  if (loading) {
    return null;
  }

  if (existing) {
    return (
      <div className="mt-6 flex items-center gap-3 text-sm">
        <span
          className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1 rounded-full border ${badgeClasses(
            existing.status
          )}`}
        >
          <span className="w-2 h-2 rounded-full bg-current shrink-0 opacity-70" />
          {statusLabel(existing.status)}
        </span>
        <Link
          href="/dashboard/refunds"
          className="text-[#0D0F14] underline decoration-slate-300 hover:decoration-slate-500 text-xs"
        >
          View refund details
        </Link>
      </div>
    );
  }

  if (!eligible) {
    return null;
  }

  return (
    <>
      <div className="mt-6">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border border-slate-200 text-[#0D0F14] hover:bg-slate-50 transition-colors"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              d="M3 8a5 5 0 119 3.2M3 8V4M3 8h4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Request refund
        </button>
        <p className="text-xs text-slate-400 mt-1.5">
          Eligible within 30 days of the charge.
        </p>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="refund-modal-title"
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => !submitting && setOpen(false)}
            aria-hidden="true"
          />
          <form
            onSubmit={handleSubmit}
            className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          >
            <div className="px-6 py-5 border-b border-slate-100">
              <h2
                id="refund-modal-title"
                className="text-base font-semibold text-[#0D0F14]"
              >
                Request a refund
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                We&apos;ll review and refund eligible charges. Recent Stripe
                charges (&lt; 24h) are processed automatically.
              </p>
            </div>

            <div className="px-6 py-5 space-y-4">
              <fieldset>
                <legend className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                  What happened?
                </legend>
                <div className="space-y-2">
                  {REASONS.map((r) => (
                    <label
                      key={r.value}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        reason === r.value
                          ? "border-[#0D0F14] bg-slate-50"
                          : "border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <input
                        type="radio"
                        name="reason"
                        value={r.value}
                        checked={reason === r.value}
                        onChange={() => setReason(r.value)}
                        className="mt-0.5 accent-[#0D0F14]"
                      />
                      <span>
                        <span className="text-sm font-medium text-[#0D0F14] block">
                          {r.label}
                        </span>
                        <span className="text-xs text-slate-500 block mt-0.5">
                          {r.help}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div>
                <label
                  htmlFor="explanation"
                  className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2 block"
                >
                  Tell us what happened (optional)
                </label>
                <textarea
                  id="explanation"
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm placeholder-slate-300 focus:outline-none focus:border-[#0D0F14]"
                  placeholder="Anything that helps us resolve this faster."
                />
              </div>

              {submitError && (
                <p className="text-sm text-red-600">{submitError}</p>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={submitting}
                className="text-sm font-medium px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !reason}
                className="text-sm font-semibold px-4 py-2 rounded-lg bg-[#0D0F14] text-white hover:bg-[#1a2333] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Submitting…" : "Submit request"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
