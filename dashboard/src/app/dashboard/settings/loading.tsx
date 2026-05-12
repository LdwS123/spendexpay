// Suspense boundary for /dashboard/settings.
// Mirrors page.tsx: header, profile form, danger zone.
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading settings…</span>

      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4">
        <div className="h-5 w-24 rounded bg-slate-100 animate-pulse" />
        <div className="h-3 w-56 rounded bg-slate-100 animate-pulse mt-2" />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-2xl space-y-5">
        {/* Profile card */}
        <div className="bg-white rounded-xl border border-slate-100 p-6">
          <div className="h-4 w-24 rounded bg-slate-100 animate-pulse mb-1" />
          <div className="h-3 w-64 rounded bg-slate-100 animate-pulse mb-5" />

          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i}>
                <div className="h-3 w-28 rounded bg-slate-100 animate-pulse mb-1.5" />
                <div className="h-10 w-full rounded-lg bg-slate-100 animate-pulse" />
              </div>
            ))}
          </div>
        </div>

        <div className="h-10 w-32 rounded-lg bg-slate-100 animate-pulse" />

        <div className="border-t border-slate-100" />

        {/* Danger zone */}
        <div className="bg-white rounded-xl border border-slate-100 p-6">
          <div className="h-4 w-28 rounded bg-slate-100 animate-pulse mb-1" />
          <div className="h-3 w-56 rounded bg-slate-100 animate-pulse mb-4" />
          <div className="h-9 w-36 rounded-lg bg-slate-100 animate-pulse" />
        </div>
      </div>
    </main>
  );
}
