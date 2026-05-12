// Suspense boundary for /dashboard/accounts.
// Mirrors page.tsx: header + grid of managed-account cards.
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading managed accounts…</span>

      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4">
        <div className="h-5 w-44 rounded bg-slate-100 animate-pulse" />
        <div className="h-3 w-80 rounded bg-slate-100 animate-pulse mt-2" />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-5xl">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-white border border-slate-100 rounded-xl p-5 space-y-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-lg bg-slate-100 animate-pulse" />
                  <div className="space-y-1.5">
                    <div className="h-4 w-28 rounded bg-slate-100 animate-pulse" />
                    <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
                  </div>
                </div>
                <div className="h-5 w-16 rounded-full bg-slate-100 animate-pulse" />
              </div>

              <div>
                <div className="h-2.5 w-20 rounded bg-slate-100 animate-pulse mb-1.5" />
                <div className="h-9 w-full rounded-lg bg-slate-100 animate-pulse" />
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
                <div className="h-3 w-20 rounded bg-slate-100 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
