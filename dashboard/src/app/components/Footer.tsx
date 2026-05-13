import Link from "next/link";

// ─── Footer ──────────────────────────────────────────────────────────────────
//
// Public footer used on landing, docs, and the legal pages. Keeps the dark
// navy palette of the marketing site so links never appear on a contrasting
// background.

export default function Footer() {
  return (
    <footer className="border-t border-white/5 bg-[#0D0F14]">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-bold text-white/40">
            Spendex <span className="text-[#6D5BFF]/70">Pay</span>
          </span>
          <span className="text-xs text-white/25">
            © 2026 Spendex AI. All rights reserved.
          </span>
        </div>

        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          <Link
            href="/legal/privacy"
            className="text-xs text-white/40 transition-colors hover:text-white"
          >
            Privacy
          </Link>
          <Link
            href="/legal/terms"
            className="text-xs text-white/40 transition-colors hover:text-white"
          >
            Terms
          </Link>
          <Link
            href="/legal/refunds"
            className="text-xs text-white/40 transition-colors hover:text-white"
          >
            Refunds
          </Link>
          <a
            href="mailto:support@spendexai.com"
            className="text-xs text-white/40 transition-colors hover:text-white"
          >
            Support
          </a>
          <a
            href="https://status.spendexai.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-white/40 transition-colors hover:text-white"
          >
            Status
          </a>
        </nav>
      </div>
    </footer>
  );
}
