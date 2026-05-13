"use client";

import { useEffect, useState, useCallback } from "react";

export interface ToastMessage {
  id: string;
  title: string;
  body?: string;
}

interface RealtimeToastStackProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

/**
 * Stack of self-dismissing toasts pinned to the bottom-right.
 * Each toast auto-dismisses after 5 seconds.
 */
export function RealtimeToastStack({ toasts, onDismiss }: RealtimeToastStackProps) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-[22rem]"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}) {
  const dismiss = useCallback(() => onDismiss(toast.id), [toast.id, onDismiss]);

  useEffect(() => {
    const timer = window.setTimeout(dismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [dismiss]);

  return (
    <div className="realtime-toast-enter pointer-events-auto rounded-xl border border-slate-100 bg-white shadow-lg shadow-slate-900/5 px-4 py-3 flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#6D5BFF]/15 text-[#3B82F6]">
        <svg
          className="h-3 w-3"
          fill="none"
          viewBox="0 0 16 16"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[#0D0F14] leading-tight">{toast.title}</p>
        {toast.body && (
          <p className="text-xs text-slate-500 mt-0.5 leading-snug">{toast.body}</p>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 text-slate-300 hover:text-slate-500 transition-colors"
        aria-label="Dismiss"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 16 16"
          stroke="currentColor"
          strokeWidth={1.75}
          aria-hidden="true"
        >
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Lightweight hook for managing a toast stack. Caller pushes messages;
 * dismissal is handled internally (timer) or via the returned `dismiss`.
 */
export function useToasts(): {
  toasts: ToastMessage[];
  push: (msg: Omit<ToastMessage, "id">) => void;
  dismiss: (id: string) => void;
} {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const push = useCallback((msg: Omit<ToastMessage, "id">) => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...msg, id }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}
