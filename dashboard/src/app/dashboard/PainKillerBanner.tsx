import Link from "next/link";

// ─────────────────────────────────────────────────────────────────────────────
// PainKillerBanner — the top-of-page hook for a brand-new dashboard.
//
// Rendered ONLY when the user has zero transactions on file. The whole point
// is to give a first-time visitor (often a VC or a new operator) the
// one-line pitch before they have any data: "your agent is ready to ship".
// As soon as a single charge clears, this banner disappears and the regular
// stats / chart / activity surface takes over.
// ─────────────────────────────────────────────────────────────────────────────

export default function PainKillerBanner() {
  return (
    <section
      aria-label="Spendex onboarding pitch"
      className="mb-5 overflow-hidden rounded-2xl border border-[#00e5b4]/25 bg-gradient-to-br from-[#070d18] via-[#0a1322] to-[#0e1a2d] text-white"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 px-5 py-5 sm:px-6 sm:py-6">
        <div className="flex-1 min-w-0">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#00e5b4]">
            <span
              className="inline-flex h-1.5 w-1.5 rounded-full bg-[#00e5b4]"
              aria-hidden="true"
            />
            Ready to ship
          </p>
          <h2 className="mt-2 text-lg sm:text-xl font-semibold leading-snug tracking-tight">
            Your agent is ready to ship.
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-white/65 max-w-2xl">
            Install Spendex in Claude Code, set your rules, and your agent can
            sign up + pay anywhere — without ever interrupting your flow.
          </p>
        </div>
        <Link
          href="/docs"
          className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-[#00e5b4] px-4 py-2.5 text-sm font-semibold text-[#070d18] transition-colors hover:bg-[#00c49a] self-start sm:self-auto"
        >
          Setup in 2 minutes →
        </Link>
      </div>
    </section>
  );
}
