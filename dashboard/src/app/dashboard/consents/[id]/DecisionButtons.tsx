"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface DecisionButtonsProps {
  consentId: string;
  options: string[];
}

/**
 * Client component rendering one button per option in the consent request.
 *
 * On click, POSTs to /api/consent/[id]/decide-from-dashboard with the chosen
 * option and redirects back to the consent list on success. Loading state is
 * tracked per button so the rest of the form stays disabled while a decision
 * is in flight (we don't want two parallel POSTs racing).
 */
export default function DecisionButtons({
  consentId,
  options,
}: DecisionButtonsProps) {
  const router = useRouter();
  const [busyOption, setBusyOption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Coerce options to a safe list of non-empty strings. If the DB row had a
  // malformed `options` array we still render *something* instead of crashing.
  const safeOptions = Array.isArray(options)
    ? options.filter((o): o is string => typeof o === "string" && o.length > 0)
    : [];

  async function handleDecide(option: string) {
    if (busyOption) return;
    setBusyOption(option);
    setError(null);

    try {
      const res = await fetch(
        `/api/consent/${encodeURIComponent(consentId)}/decide-from-dashboard`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ option }),
        }
      );

      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
      };

      if (!res.ok || !body.success) {
        setError(body.error ?? `Failed (${res.status})`);
        setBusyOption(null);
        return;
      }

      router.push("/dashboard/consents");
      router.refresh();
    } catch {
      setError("Network error — please try again.");
      setBusyOption(null);
    }
  }

  if (safeOptions.length === 0) {
    return (
      <p className="text-xs text-slate-400 italic">
        This request has no decision options.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {safeOptions.map((option) => {
          const isDecline = option.toLowerCase() === "decline";
          const isBusy = busyOption === option;
          const baseCls = isDecline
            ? "border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50"
            : "border-[#00e5b4] bg-[#00e5b4] text-[#070d18] hover:bg-[#00c49a]";
          return (
            <button
              key={option}
              type="button"
              disabled={busyOption !== null}
              onClick={() => handleDecide(option)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${baseCls}`}
            >
              {isBusy ? "Submitting…" : option}
            </button>
          );
        })}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
