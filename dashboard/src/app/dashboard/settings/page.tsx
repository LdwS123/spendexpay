"use client";

import { useState, useEffect } from "react";
import { browserClient } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SaveState = "idle" | "saving" | "saved" | "error";
type DeleteState = "idle" | "confirming" | "deleting" | "error";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  // ── Profile fields ──────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Danger zone ─────────────────────────────────────────────────────────
  const [deleteState, setDeleteState] = useState<DeleteState>("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Seed fields from current session ────────────────────────────────────
  useEffect(() => {
    async function loadUser() {
      const {
        data: { user },
      } = await browserClient.auth.getUser();
      if (!user) return;
      setEmail(user.email ?? "");

      // Pull display_name and phone from public.users if they exist
      const { data } = await browserClient
        .from("users")
        .select("display_name, phone_number")
        .eq("id", user.id)
        .maybeSingle();

      if (data) {
        setDisplayName((data as { display_name?: string }).display_name ?? "");
        setPhoneNumber((data as { phone_number?: string }).phone_number ?? "");
      }
    }
    loadUser();
  }, []);

  // ── Save profile ─────────────────────────────────────────────────────────
  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveState("saving");
    setSaveError(null);

    try {
      const res = await fetch("/api/settings/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName || undefined,
          phone_number: phoneNumber || undefined,
        }),
      });

      const json = (await res.json()) as { success?: boolean; error?: string };

      if (!res.ok || !json.success) {
        setSaveState("error");
        setSaveError(json.error ?? "Something went wrong.");
        return;
      }

      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2500);
    } catch {
      setSaveState("error");
      setSaveError("Network error — please try again.");
    }
  }

  // ── Delete account ───────────────────────────────────────────────────────
  async function handleDeleteConfirm() {
    setDeleteState("deleting");
    setDeleteError(null);

    try {
      const res = await fetch("/api/settings/account", { method: "DELETE" });
      const json = (await res.json()) as { success?: boolean; error?: string };

      if (!res.ok || !json.success) {
        setDeleteState("error");
        setDeleteError(json.error ?? "Something went wrong.");
        return;
      }

      // Session is now invalid — sign out locally and redirect
      await browserClient.auth.signOut();
      window.location.href = "/";
    } catch {
      setDeleteState("error");
      setDeleteError("Network error — please try again.");
    }
  }

  // ── Derived UI helpers ───────────────────────────────────────────────────
  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "saved"
        ? "Saved"
        : "Save changes";

  const saveCls =
    saveState === "saved"
      ? "bg-[#00e5b4]/15 text-[#00a882] cursor-default"
      : saveState === "saving"
        ? "bg-[#00e5b4]/60 text-[#070d18] cursor-not-allowed"
        : "bg-[#00e5b4] hover:bg-[#00c49a] text-[#070d18]";

  return (
    <main>
      {/* ── Header ── */}
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4">
        <h1 className="text-lg font-semibold text-[#0a1220]">Settings</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Manage your profile and account.
        </p>
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-2xl space-y-5">

        {/* ── Section 1 — Profile ── */}
        <form onSubmit={handleSave}>
          <div className="bg-white rounded-xl border border-slate-100 p-6">
            <h2 className="text-sm font-semibold text-[#0a1220] mb-1">Profile</h2>
            <p className="text-xs text-slate-400 mb-5">
              Your name and phone are synced to your Spendex virtual card.
            </p>

            <div className="space-y-4">
              {/* Display name */}
              <div>
                <label
                  htmlFor="display_name"
                  className="block text-xs font-medium text-slate-600 mb-1.5"
                >
                  Display name
                </label>
                <input
                  id="display_name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Jane Doe"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#00e5b4] focus:border-[#00e5b4]"
                />
              </div>

              {/* Email — read-only from auth */}
              <div>
                <label
                  htmlFor="email"
                  className="block text-xs font-medium text-slate-600 mb-1.5"
                >
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  readOnly
                  tabIndex={-1}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm bg-slate-50 text-slate-400 cursor-not-allowed select-none"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Email cannot be changed here. Contact support if you need to update it.
                </p>
              </div>

              {/* Phone number */}
              <div>
                <label
                  htmlFor="phone_number"
                  className="block text-xs font-medium text-slate-600 mb-1.5"
                >
                  Phone number
                </label>
                <input
                  id="phone_number"
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="+33 6 00 00 00 00"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#00e5b4] focus:border-[#00e5b4]"
                />
              </div>
            </div>

            {/* Save error */}
            {saveState === "error" && saveError && (
              <p className="mt-4 text-xs text-red-500">{saveError}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={saveState === "saving" || saveState === "saved"}
            className={`mt-4 font-semibold text-sm px-5 py-2.5 rounded-lg transition-colors ${saveCls}`}
          >
            {saveLabel}
          </button>
        </form>

        {/* ── Divider ── */}
        <div className="border-t border-slate-100" />

        {/* ── Section 2 — Danger zone ── */}
        <div className="bg-white rounded-xl border border-slate-100 p-6">
          <h2 className="text-sm font-semibold text-[#0a1220] mb-1">Danger zone</h2>
          <p className="text-xs text-slate-400 mb-4">
            Permanent actions that cannot be undone.
          </p>

          {/* Idle or error state — show delete button */}
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

          {/* Confirmation step */}
          {deleteState === "confirming" && (
            <div className="rounded-lg border border-red-100 bg-red-50/60 p-4 space-y-3">
              <p className="text-sm font-medium text-red-700">
                Are you sure? This will permanently delete your account and all associated data.
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleDeleteConfirm}
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

          {/* Deleting spinner */}
          {deleteState === "deleting" && (
            <p className="text-sm text-slate-500">Deleting your account…</p>
          )}
        </div>

      </div>
    </main>
  );
}
