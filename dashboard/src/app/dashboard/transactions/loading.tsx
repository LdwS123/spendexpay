// Suspense boundary for /dashboard/transactions.
// Mirrors page.tsx: header, filter pills, table with 8 skeleton rows.
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading transactions…</span>

      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-5 w-32 rounded bg-slate-100 animate-pulse" />
          <div className="h-3 w-56 rounded bg-slate-100 animate-pulse" />
        </div>
        <div className="h-3 w-20 rounded bg-slate-100 animate-pulse" />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-5xl">
        {/* Filters */}
        <div className="flex items-center gap-3 mb-5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-7 w-16 rounded-lg bg-slate-100 animate-pulse"
            />
          ))}
          <div className="ml-auto h-3 w-16 rounded bg-slate-100 animate-pulse" />
        </div>

        <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
          {/* Table header — hidden on mobile (cards layout) */}
          <div className="hidden sm:flex items-center gap-4 px-5 py-2.5 border-b border-slate-100 bg-slate-50/50">
            <div className="w-8 shrink-0" />
            <div className="flex-1 h-3 w-16 rounded bg-slate-100 animate-pulse" />
            <div className="shrink-0 w-28 h-3 rounded bg-slate-100 animate-pulse" />
            <div className="shrink-0 w-20 h-3 rounded bg-slate-100 animate-pulse" />
            <div className="shrink-0 w-40 h-3 rounded bg-slate-100 animate-pulse" />
          </div>

          {/* Rows */}
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3.5 border-b border-slate-50 last:border-b-0"
            >
              <div className="w-8 h-8 rounded-lg bg-slate-100 animate-pulse shrink-0" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="h-4 w-32 max-w-full rounded bg-slate-100 animate-pulse" />
                <div className="h-3 w-48 max-w-full rounded bg-slate-100 animate-pulse" />
              </div>
              <div className="hidden sm:block shrink-0">
                <div className="h-5 w-20 rounded-full bg-slate-100 animate-pulse" />
              </div>
              <div className="hidden sm:flex shrink-0 w-20 justify-end">
                <div className="h-4 w-14 rounded bg-slate-100 animate-pulse" />
              </div>
              <div className="hidden sm:flex shrink-0 w-40 justify-end">
                <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
              </div>
              {/* Mobile amount */}
              <div className="sm:hidden shrink-0">
                <div className="h-4 w-14 rounded bg-slate-100 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
