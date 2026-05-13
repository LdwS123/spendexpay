"use client";

/**
 * 2FA enrolment and management section, used by the Settings page.
 *
 * Internal state machine:
 *
 *   loading       → initial fetch of /api/2fa/status
 *   off           → user has no 2FA on; shows "Enable 2FA"
 *   enrolling     → /api/2fa/setup returned a QR; show it + code input
 *   showingCodes  → enrolment complete; we display the 10 recovery codes
 *                   one and only one time
 *   on            → 2FA is on; shows "Disable 2FA"
 *   disabling     → user clicked disable; show code input modal
 *
 * The display flow is intentionally linear — the user can always click
 * "Cancel" to go back to the previous resting state.
 */

import { useCallback, useEffect, useState } from "react";

type Step =
  | "loading"
  | "off"
  | "enrolling"
  | "showingCodes"
  | "on"
  | "disabling";

interface SetupResponse {
  secret: string;
  qrDataUrl: string;
  otpAuthUrl: string;
}

interface VerifyResponse {
  enabled: boolean;
  recoveryCodes: string[];
}

export default function TwoFactorSection() {
  const [step, setStep] = useState<Step>("loading");
  const [setupData, setSetupData] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ─── initial status fetch ──────────────────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/2fa/status");
      const json = (await res.json()) as { enabled?: boolean; error?: string };
      if (!res.ok) {
        setError(json.error ?? "Failed to load 2FA status");
        setStep("off");
        return;
      }
      setStep(json.enabled ? "on" : "off");
    } catch {
      setError("Network error");
      setStep("off");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // ─── enrolment flow ────────────────────────────────────────────────────────
  async function startEnrolment(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/2fa/setup", { method: "POST" });
      const json = (await res.json()) as SetupResponse & { error?: string };
      if (!res.ok || !json.qrDataUrl) {
        setError(json.error ?? "Failed to start 2FA setup");
        return;
      }
      setSetupData({
        secret: json.secret,
        qrDataUrl: json.qrDataUrl,
        otpAuthUrl: json.otpAuthUrl,
      });
      setCode("");
      setStep("enrolling");
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function submitVerify(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const json = (await res.json()) as VerifyResponse & { error?: string };
      if (!res.ok || !json.enabled) {
        setError(
          json.error === "invalid_code"
            ? "That code doesn't match — try again."
            : (json.error ?? "Failed to verify")
        );
        return;
      }
      setRecoveryCodes(json.recoveryCodes);
      setCode("");
      setStep("showingCodes");
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  // ─── disable flow ──────────────────────────────────────────────────────────
  async function submitDisable(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const json = (await res.json()) as { enabled?: boolean; error?: string };
      if (!res.ok) {
        setError(
          json.error === "invalid_code"
            ? "That code doesn't match — try again."
            : (json.error ?? "Failed to disable 2FA")
        );
        return;
      }
      setCode("");
      setStep("off");
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  // ─── rendering ─────────────────────────────────────────────────────────────
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-6">
      <h2 className="text-sm font-semibold text-[#0D0F14] mb-1">
        Two-factor authentication
      </h2>
      <p className="text-xs text-slate-400 mb-4">
        Require a one-time code for sensitive actions (deleting payment methods,
        rotating MCP tokens, deleting your account).
      </p>

      {step === "loading" && (
        <p className="text-xs text-slate-400">Checking 2FA status…</p>
      )}

      {step === "off" && (
        <div className="space-y-3">
          <button
            type="button"
            disabled={busy}
            onClick={startEnrolment}
            className="text-sm font-semibold text-[#0D0F14] bg-[#6D5BFF] hover:bg-[#5b48ff] disabled:opacity-50 px-4 py-2 rounded-lg transition-colors"
          >
            {busy ? "Starting…" : "Enable 2FA"}
          </button>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      )}

      {step === "enrolling" && setupData && (
        <div className="space-y-4">
          <div className="flex items-start gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={setupData.qrDataUrl}
              alt="2FA QR code"
              width={160}
              height={160}
              className="border border-slate-200 rounded-lg"
            />
            <div className="text-xs text-slate-500 leading-relaxed">
              <p>
                Scan with Google Authenticator, 1Password, Authy, or any other
                TOTP app.
              </p>
              <p className="mt-2 text-slate-400">
                Or enter this code manually:
              </p>
              <code className="block mt-1 font-mono text-[11px] bg-slate-50 border border-slate-100 rounded px-2 py-1 break-all">
                {setupData.secret}
              </code>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Enter the 6-digit code from your app
            </label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D+/g, ""))}
              placeholder="123 456"
              className="w-40 border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-mono tracking-widest focus:outline-none focus:ring-1 focus:ring-[#6D5BFF] focus:border-[#6D5BFF]"
            />
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || code.length !== 6}
              onClick={submitVerify}
              className="text-sm font-semibold text-[#0D0F14] bg-[#6D5BFF] hover:bg-[#5b48ff] disabled:opacity-50 px-4 py-2 rounded-lg transition-colors"
            >
              {busy ? "Verifying…" : "Verify and enable"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setStep("off");
                setError(null);
                setCode("");
              }}
              className="text-sm font-medium text-slate-600 hover:text-slate-800 border border-slate-200 hover:border-slate-300 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "showingCodes" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-800">
              Save these recovery codes somewhere safe.
            </p>
            <p className="text-[11px] text-amber-700 mt-1">
              They won&rsquo;t be shown again. Each code works once if you lose
              access to your authenticator app.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 font-mono text-xs">
            {recoveryCodes.map((c) => (
              <code
                key={c}
                className="bg-slate-50 border border-slate-100 rounded px-2 py-1.5 select-all"
              >
                {c}
              </code>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(recoveryCodes.join("\n"));
                } catch {
                  // browser may block; user can still select manually
                }
              }}
              className="text-xs font-medium text-slate-700 hover:text-[#0D0F14] border border-slate-200 hover:border-slate-300 bg-white rounded-lg px-3 py-2 transition-colors"
            >
              Copy all codes
            </button>
            <button
              type="button"
              onClick={() => {
                setRecoveryCodes([]);
                setStep("on");
              }}
              className="text-xs font-semibold text-[#0D0F14] bg-[#6D5BFF] hover:bg-[#5b48ff] px-3 py-2 rounded-lg transition-colors"
            >
              I&rsquo;ve saved them
            </button>
          </div>
        </div>
      )}

      {step === "on" && (
        <div className="space-y-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#3B82F6] bg-[#6D5BFF]/15 px-2.5 py-1 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6]" />
            2FA enabled
          </span>
          <div>
            <button
              type="button"
              onClick={() => {
                setStep("disabling");
                setError(null);
                setCode("");
              }}
              className="text-sm text-red-500 hover:text-red-600 font-medium border border-red-200 hover:border-red-300 px-4 py-2 rounded-lg transition-colors"
            >
              Disable 2FA
            </button>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      )}

      {step === "disabling" && (
        <div className="space-y-3 rounded-lg border border-red-100 bg-red-50/60 p-4">
          <p className="text-sm font-medium text-red-700">
            Enter a 2FA code (or a recovery code) to disable 2FA.
          </p>
          <input
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456 or XXXX-XXXX-XXXX"
            className="w-full max-w-xs border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-red-300 focus:border-red-300"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || code.length < 6}
              onClick={submitDisable}
              className="text-sm font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-50 px-4 py-2 rounded-lg transition-colors"
            >
              {busy ? "Disabling…" : "Yes, disable 2FA"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setStep("on");
                setError(null);
                setCode("");
              }}
              className="text-sm font-medium text-slate-600 hover:text-slate-800 border border-slate-200 hover:border-slate-300 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
