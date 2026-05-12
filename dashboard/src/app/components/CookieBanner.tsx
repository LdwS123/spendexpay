"use client";

import { useEffect, useState } from "react";

// ─── Cookie banner ───────────────────────────────────────────────────────────
//
// We only set a single session cookie for authentication, no tracking. To
// stay GDPR-friendly we still surface a tiny notice so the user can confirm
// they've seen it. Once accepted, we drop a long-lived `spendex-cookies-
// accepted` cookie and never render the banner again.
//
// The component is intentionally a client component because cookie reads
// during SSR would force the layout into a dynamic render and we'd rather
// keep the marketing pages fully static.

const COOKIE_NAME = "spendex-cookies-accepted";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function hasAcceptedCookie(): boolean {
  if (typeof document === "undefined") return true; // SSR — assume accepted to avoid hydration flicker
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith(`${COOKIE_NAME}=`));
}

export default function CookieBanner() {
  // Start hidden to avoid a hydration mismatch — we'll reveal it from useEffect.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!hasAcceptedCookie()) {
      setVisible(true);
    }
  }, []);

  const accept = () => {
    document.cookie = `${COOKIE_NAME}=1; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Cookie notice"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-2xl rounded-xl border border-white/10 bg-[#070d18]/95 px-4 py-3 shadow-2xl shadow-black/40 backdrop-blur-md sm:inset-x-auto sm:right-4 sm:left-auto"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-relaxed text-white/70">
          We use a single session cookie for authentication. No tracking.
        </p>
        <button
          type="button"
          onClick={accept}
          className="self-start rounded-md bg-[#00e5b4] px-4 py-1.5 text-xs font-semibold text-[#070d18] transition-opacity hover:opacity-90 sm:self-auto"
        >
          OK
        </button>
      </div>
    </div>
  );
}
