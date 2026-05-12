"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  accountId: string;
  isRevoked: boolean;
  isPrimary: boolean;
}

interface ErrorResponse {
  error: string;
}

/**
 * Client-side action panel for a managed account.
 *
 * "Revoke" calls DELETE /api/accounts/[id] which flips status='revoked' (the
 * row is preserved for audit). "Mark as primary" toggles is_primary via POST
 * /api/accounts/[id]/set-primary. After either call we refresh() the server
 * component so the badge / button state updates without a full reload.
 */
export default function AccountActions({
  accountId,
  isRevoked,
  isPrimary,
}: Props) {
  const router = useRouter();
  const [revoking, setRevoking] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [primaryLoading, setPrimaryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setRevoking(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as ErrorResponse | null;
        setError(json?.error ?? "Failed to revoke account");
        return;
      }
      setConfirmRevoke(false);
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setRevoking(false);
    }
  }

  async function togglePrimary() {
    setPrimaryLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/set-primary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primary: !isPrimary }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as ErrorResponse | null;
        setError(json?.error ?? "Failed to update primary status");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setPrimaryLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={togglePrimary}
          disabled={isRevoked || primaryLoading}
          className="text-xs font-semibold text-[#0a1220] bg-white border border-slate-200 hover:border-slate-300 rounded-lg px-3 py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {primaryLoading
            ? "Updating…"
            : isPrimary
            ? "Unmark as primary"
            : "Mark as primary"}
        </button>

        <button
          type="button"
          onClick={() => setConfirmRevoke(true)}
          disabled={isRevoked || revoking}
          className="text-xs font-semibold text-red-600 bg-white border border-red-200 hover:bg-red-50 hover:border-red-300 rounded-lg px-3 py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRevoked ? "Revoked" : "Revoke account"}
        </button>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <p className="text-[11px] text-slate-400 leading-relaxed max-w-md">
        Revoking marks the account as inactive for billing and credentials —
        the row is preserved for audit history.
      </p>

      {confirmRevoke && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-[#070d18]/50"
          onClick={() => !revoking && setConfirmRevoke(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border border-slate-100 max-w-sm w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-[#0a1220]">
              Revoke this managed account?
            </p>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
              The agent will no longer be able to use the credentials for billing
              or sign-in. This action cannot be undone from the dashboard.
            </p>

            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setConfirmRevoke(false)}
                disabled={revoking}
                className="text-xs font-semibold text-[#0a1220] bg-white border border-slate-200 hover:border-slate-300 rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={revoke}
                disabled={revoking}
                className="text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
              >
                {revoking ? "Revoking…" : "Revoke"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
