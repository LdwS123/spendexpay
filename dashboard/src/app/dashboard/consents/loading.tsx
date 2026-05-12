// Suspense boundary for /dashboard/consents.
// Mirrors page.tsx: header, pending cards grid, history table.
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading consents…</span>

      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-5 w-24 rounded bg-slate-100 animate-pulse" />
          <div className="h-3 w-72 rounded bg-slate-100 animate-pulse" />
        </div>
        <div className="h-3 w-24 rounded bg-slate-100 animate-pulse" />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-5xl space-y-8">
        {/* Pending section */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="h-4 w-20 rounded bg-slate-100 animate-pulse" />
            <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="bg-white border border-slate-100 rounded-xl p-5 space-y-4"
              >
                <div className="space-y-2">
                  <div className="h-5 w-20 rounded-full bg-slate-100 animate-pulse" />
                  <div className="h-4 w-3/4 rounded bg-slate-100 animate-pulse" />
                  <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 space-y-1.5">
                  <div className="h-3 w-2/3 rounded bg-slate-100 animate-pulse" />
                  <div className="h-3 w-1/2 rounded bg-slate-100 animate-pulse" />
                </div>
                <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                  <div className="h-3 w-40 rounded bg-slate-100 animate-pulse" />
                  <div className="h-7 w-20 rounded-lg bg-slate-100 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Recent / history */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="h-4 w-16 rounded bg-slate-100 animate-pulse" />
            <div className="h-3 w-16 rounded bg-slate-100 animate-pulse" />
          </div>
          <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-3 flex gap-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="h-3 w-20 rounded bg-slate-100 animate-pulse"
                />
              ))}
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-4 px-5 py-3 border-b border-slate-50 last:border-b-0"
              >
                <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
                <div className="h-4 w-20 rounded bg-slate-100 animate-pulse" />
                <div className="h-3 w-32 rounded bg-slate-100 animate-pulse hidden md:block" />
                <div className="h-5 w-20 rounded-full bg-slate-100 animate-pulse" />
                <div className="ml-auto h-3 w-12 rounded bg-slate-100 animate-pulse" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
