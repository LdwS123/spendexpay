"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// Danger zone — account deletion with optional 2FA challenge. Extracted from
// the previous Settings page so the new tab-based Settings can keep this
// behaviour exactly as it was.
// ─────────────────────────────────────────────────────────────────────────────

type DeleteState =
  | "idle"
  | "confirming"
  | "needs2fa"
  | "deleting"
  | "error";

export default function DangerZoneSection() {
  const [deleteState, setDeleteState] = useState<DeleteState>("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteTwoFactorCode, setDeleteTwoFactorCode] = useState("");

  async function handleDeleteConfirm(twoFactorCode?: string) {
    setDeleteState("deleting");
    setDeleteError(null);

    try {
      const headers: Record<string, string> = {};
      if (twoFactorCode) headers["X-2FA-Code"] = twoFactorCode;
      const res = await fetch("/api/settings/account", {
        method: "DELETE",
        headers,
      });
      const json = (await res.json()) as { success?: boolean; error?: string };

      // 409 with "2fa_required" — surface the code prompt and re-arm the
      // delete flow once the user types their TOTP code.
      if (res.status === 409 && json.error === "2fa_required") {
        setDeleteState("needs2fa");
        setDeleteError(null);
        return;
      }

      if (!res.ok || !json.success) {
        setDeleteState("error");
        setDeleteError(json.error ?? "Something went wrong.");
        return;
      }

      // Session is now invalid — sign out locally and redirect.
      await browserClient.auth.signOut();
      window.location.href = "/";
    } catch {
      setDeleteState("error");
      setDeleteError("Network error — please try again.");
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-100 p-6">
      <h2 className="text-sm font-semibold text-[#0D0F14] mb-1">Danger zone</h2>
      <p className="text-xs text-slate-400 mb-4">
        Permanent actions that cannot be undone.
      </p>

      {(deleteState === "idle" || deleteState === "error") && (
        <>
          <button
            type="button"
            onClick={() => {
              setDeleteState("confirming");
              setDeleteError(null);
            }}
            className="text-sm text-red-500 hover:text-red-600 font-medium border border-red-200 hover:border-red-300 px-4 py-2 rounded-lg transition-colors"
          >
            Delete account
          </button>
          {deleteState === "error" && deleteError && (
            <p className="mt-2 text-xs text-red-500">{deleteError}</p>
          )}
        </>
      )}

      {deleteState === "confirming" && (
        <div className="rounded-lg border border-red-100 bg-red-50/60 p-4 space-y-3">
          <p className="text-sm font-medium text-red-700">
            Are you sure? This will permanently delete your account and all
            associated data.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => handleDeleteConfirm()}
              className="text-sm font-semibold text-white bg-red-500 hover:bg-red-600 px-4 py-2 rounded-lg transition-colors"
            >
              Yes, delete my account
            </button>
            <button
              type="button"
              onClick={() => setDeleteState("idle")}
              className="text-sm font-medium text-slate-600 hover:text-slate-800 px-4 py-2 rounded-lg border border-slate-200 hover:border-slate-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {deleteState === "needs2fa" && (
        <div className="rounded-lg border border-red-100 bg-red-50/60 p-4 space-y-3">
          <p className="text-sm font-medium text-red-700">
            Enter your 2FA code to confirm account deletion.
          </p>
          <input
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            value={deleteTwoFactorCode}
            onChange={(e) => setDeleteTwoFactorCode(e.target.value)}
            placeholder="123456 or recovery code"
            className="w-full max-w-xs border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-red-300 focus:border-red-300"
          />
          {deleteError && (
            <p className="text-xs text-red-600">{deleteError}</p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={deleteTwoFactorCode.length < 6}
              onClick={() => handleDeleteConfirm(deleteTwoFactorCode)}
              className="text-sm font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-50 px-4 py-2 rounded-lg transition-colors"
            >
              Confirm delete
            </button>
            <button
              type="button"
              onClick={() => {
                setDeleteState("idle");
                setDeleteTwoFactorCode("");
              }}
              className="text-sm font-medium text-slate-600 hover:text-slate-800 px-4 py-2 rounded-lg border border-slate-200 hover:border-slate-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {deleteState === "deleting" && (
        <p className="text-sm text-slate-500">Deleting your account…</p>
      )}
    </div>
  );
}
