// Suspense boundary for /dashboard/orders.
// Mirrors page.tsx: header, three stat cards, then two day-groups of order
// rows with 64×64 thumbnails. Grey blocks animate via Tailwind's animate-pulse.
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading orders…</span>

      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-5 w-24 rounded bg-slate-100 animate-pulse" />
          <div className="h-3 w-64 rounded bg-slate-100 animate-pulse" />
        </div>
        <div className="h-3 w-16 rounded bg-slate-100 animate-pulse" />
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

        {/* Two day-groups, 3 + 2 rows */}
        <div className="space-y-7">
          {[3, 2].map((count, groupIdx) => (
            <section key={groupIdx}>
              <div className="flex items-center justify-between mb-2.5 px-1">
                <div className="h-3 w-20 rounded bg-slate-100 animate-pulse" />
                <div className="h-3 w-14 rounded bg-slate-100 animate-pulse" />
              </div>
              <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
                {Array.from({ length: count }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-4 px-5 py-4 border-b border-slate-50 last:border-b-0"
                  >
                    <div className="w-16 h-16 rounded-lg bg-slate-100 animate-pulse shrink-0" />
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="h-4 w-56 rounded bg-slate-100 animate-pulse" />
                      <div className="h-3 w-40 rounded bg-slate-100 animate-pulse" />
                      <div className="h-3 w-20 rounded bg-slate-100 animate-pulse" />
                    </div>
                    <div className="hidden sm:flex flex-col items-end shrink-0 gap-2">
                      <div className="h-5 w-16 rounded bg-slate-100 animate-pulse" />
                      <div className="h-3 w-20 rounded bg-slate-100 animate-pulse" />
                    </div>
                    <div className="flex sm:hidden flex-col items-end shrink-0">
                      <div className="h-4 w-14 rounded bg-slate-100 animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
