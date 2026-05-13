"use client";

import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// Profile section — name, email, phone. Lifted unchanged from the previous
// /dashboard/settings/page.tsx so the Settings tab UI can keep this exact
// behaviour without breaking the underlying API contract.
// ─────────────────────────────────────────────────────────────────────────────

type SaveState = "idle" | "saving" | "saved" | "error";

export default function ProfileSection() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Seed fields from current session.
  useEffect(() => {
    async function loadUser() {
      const {
        data: { user },
      } = await browserClient.auth.getUser();
      if (!user) return;
      setEmail(user.email ?? "");

      const { data } = await browserClient
        .from("users")
        .select("display_name, phone_number")
        .eq("id", user.id)
        .maybeSingle();

      if (data) {
        setDisplayName(
          (data as { display_name?: string }).display_name ?? ""
        );
        setPhoneNumber(
          (data as { phone_number?: string }).phone_number ?? ""
        );
      }
    }
    void loadUser();
  }, []);

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
    <form onSubmit={handleSave}>
      <div className="bg-white rounded-xl border border-slate-100 p-6">
        <h2 className="text-sm font-semibold text-[#0a1220] mb-1">Profile</h2>
        <p className="text-xs text-slate-400 mb-5">
          Your name and phone are synced to your Spendex virtual card.
        </p>

        <div className="space-y-4">
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
              Email cannot be changed here. Contact support if you need to
              update it.
            </p>
          </div>

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
  );
}
