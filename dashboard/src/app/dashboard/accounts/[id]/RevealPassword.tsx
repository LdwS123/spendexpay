"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

interface Props {
  accountId: string;
  disabled?: boolean;
}

interface RevealResponse {
  password: string;
}

interface ErrorResponse {
  error: string;
}

const REVEAL_TTL_MS = 60_000;

/**
 * Reveal-password modal for a managed account.
 *
 * Two-step UX:
 *   1. User clicks "Reveal password" → a confirmation modal opens.
 *   2. On confirm, we POST /api/accounts/[id]/reveal-password.
 *
 * Once revealed, the password is shown for 60 seconds then auto-hidden, so the
 * value never lingers in the DOM longer than necessary.
 */
export default function RevealPassword({ accountId, disabled = false }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descId = useId();

  const clearTimers = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [clearTimers]);

  // Focus management + Escape-to-close for the confirm dialog.
  useEffect(() => {
    if (!confirmOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Focus the dialog container so screen readers announce it and Tab is trapped.
    dialogRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !loading) {
        e.preventDefault();
        setConfirmOpen(false);
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to the trigger when the dialog closes.
      previouslyFocused?.focus?.();
    };
  }, [confirmOpen, loading]);

  const hide = useCallback(() => {
    clearTimers();
    setPassword(null);
    setSecondsLeft(0);
  }, [clearTimers]);

  const reveal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/reveal-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = (await res.json()) as RevealResponse | ErrorResponse;
      if (!res.ok || "error" in json) {
        const message =
          "error" in json ? json.error : "Failed to reveal password";
        setError(message);
        return;
      }
      setPassword(json.password);
      setSecondsLeft(Math.floor(REVEAL_TTL_MS / 1000));
      hideTimerRef.current = setTimeout(hide, REVEAL_TTL_MS);
      tickRef.current = setInterval(() => {
        setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
      }, 1000);
      setConfirmOpen(false);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }, [accountId, hide]);

  async function copy() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked — value remains visible.
    }
  }

  if (password) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 font-mono text-xs text-[#0D0F14] bg-slate-50 border border-slate-100 rounded-md px-2.5 py-2 break-all">
            {password}
          </code>
          <button
            type="button"
            onClick={copy}
            className="text-[11px] font-semibold text-slate-700 hover:text-[#0D0F14] border border-slate-200 hover:border-slate-300 bg-white rounded-md px-2.5 py-2 transition-colors shrink-0"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={hide}
            className="text-[11px] font-semibold text-[#0D0F14] bg-white border border-slate-200 hover:border-slate-300 rounded-md px-2.5 py-2 transition-colors shrink-0"
          >
            Hide
          </button>
        </div>
        <p className="text-[11px] text-slate-400">Auto-hides in {secondsLeft}s</p>
      </div>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setError(null);
          setConfirmOpen(true);
        }}
        disabled={disabled}
        className="text-xs font-semibold text-white bg-[#0D0F14] hover:bg-[#1a1f2c] rounded-lg px-3 py-2 transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6D5BFF] focus-visible:ring-offset-2"
      >
        Reveal password
      </button>
      {disabled && (
        <p className="text-[11px] text-slate-400 mt-1.5">
          This account has been revoked — credentials are no longer available.
        </p>
      )}

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center sm:px-4 bg-[#0D0F14]/50"
          onClick={() => !loading && setConfirmOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            tabIndex={-1}
            className="bg-white sm:rounded-2xl shadow-xl sm:border sm:border-slate-100 sm:max-w-sm w-full p-6 focus:outline-none h-full sm:h-auto overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <p id={titleId} className="text-sm font-semibold text-[#0D0F14]">
              Reveal account password?
            </p>
            <p id={descId} className="text-xs text-slate-600 mt-1.5 leading-relaxed">
              The password will be shown for 60 seconds. Every reveal is logged
              for audit purposes.
            </p>

            {error && (
              <p className="text-xs text-red-600 mt-3" role="alert">{error}</p>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={loading}
                className="text-xs font-semibold text-[#0D0F14] bg-white border border-slate-200 hover:border-slate-300 rounded-lg px-3 py-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6D5BFF] focus-visible:ring-offset-2"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={reveal}
                disabled={loading}
                className="text-xs font-semibold text-white bg-[#0D0F14] hover:bg-[#1a1f2c] rounded-lg px-3 py-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6D5BFF] focus-visible:ring-offset-2"
              >
                {loading ? "Revealing…" : "Reveal"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
