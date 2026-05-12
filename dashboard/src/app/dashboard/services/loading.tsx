// Suspense boundary for /dashboard/services.
// Mirrors ServicesClient: header, virtual-card preview, destinations grid.
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading services…</span>

      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4">
        <div className="h-5 w-32 rounded bg-slate-100 animate-pulse" />
        <div className="h-3 w-72 rounded bg-slate-100 animate-pulse mt-2" />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-5xl space-y-7">
        {/* Virtual card preview */}
        <div className="bg-white rounded-xl border border-slate-100 p-6">
          <div className="h-4 w-36 rounded bg-slate-100 animate-pulse mb-4" />
          <div className="rounded-2xl bg-gradient-to-br from-slate-100 to-slate-50 border border-slate-100 p-6 h-44 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="h-4 w-20 rounded bg-slate-200/80 animate-pulse" />
              <div className="h-4 w-12 rounded bg-slate-200/80 animate-pulse" />
            </div>
            <div className="space-y-2">
              <div className="h-6 w-56 rounded bg-slate-200/80 animate-pulse" />
              <div className="h-3 w-32 rounded bg-slate-200/80 animate-pulse" />
            </div>
          </div>
        </div>

        {/* Destinations grid */}
        <div>
          <div className="h-4 w-40 rounded bg-slate-100 animate-pulse mb-4" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="bg-white rounded-xl border border-slate-100 p-5"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-10 w-10 rounded-lg bg-slate-100 animate-pulse" />
                  <div className="h-4 w-24 rounded bg-slate-100 animate-pulse" />
                </div>
                <div className="h-3 w-full rounded bg-slate-100 animate-pulse mb-2" />
                <div className="h-3 w-3/4 rounded bg-slate-100 animate-pulse" />
                <div className="h-7 w-24 rounded-lg bg-slate-100 animate-pulse mt-4" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
