// Suspense boundary for /dashboard (Overview).
// Mirrors the layout of page.tsx: header, stat cards row, chart, recent
// transactions table. Grey blocks animate via Tailwind's animate-pulse.
export default function Loading() {
  return (
    <main className="flex-1 overflow-auto" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading overview…</span>

      {/* Header */}
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-5 w-28 rounded bg-slate-100 animate-pulse" />
          <div className="h-3 w-36 rounded bg-slate-100 animate-pulse" />
        </div>
        <div className="h-9 w-40 rounded-lg bg-slate-100 animate-pulse" />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-5xl">
        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-7">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="bg-white rounded-xl border border-slate-100 p-5"
            >
              <div className="h-3 w-24 rounded bg-slate-100 animate-pulse mb-3" />
              <div className="h-7 w-28 rounded bg-slate-100 animate-pulse" />
              <div className="h-3 w-20 rounded bg-slate-100 animate-pulse mt-2" />
            </div>
          ))}
        </div>

        {/* Spending chart */}
        <div className="mb-7 bg-white rounded-xl border border-slate-100 p-5">
          <div className="h-4 w-32 rounded bg-slate-100 animate-pulse mb-4" />
          <div className="h-48 w-full rounded-lg bg-slate-100 animate-pulse" />
        </div>

        {/* Recent transactions */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="space-y-2">
              <div className="h-4 w-40 rounded bg-slate-100 animate-pulse" />
              <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
            </div>
            <div className="h-3 w-14 rounded bg-slate-100 animate-pulse" />
          </div>
          <div className="bg-white rounded-xl border border-slate-100 overflow-hidden divide-y divide-slate-50">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="h-4 w-24 rounded bg-slate-100 animate-pulse" />
                <div className="flex-1 h-3 rounded bg-slate-100 animate-pulse hidden sm:block" />
                <div className="h-3 w-24 rounded bg-slate-100 animate-pulse hidden md:block" />
                <div className="h-4 w-16 rounded bg-slate-100 animate-pulse" />
                <div className="h-5 w-14 rounded-full bg-slate-100 animate-pulse" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
