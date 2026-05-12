// Suspense boundary for /dashboard/rules.
// Mirrors page.tsx: header, summary card, form sections (per-tx, monthly,
// merchant locks, exclusions, emergency stop), save button.
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading rules…</span>

      <header className="bg-white border-b border-slate-100 px-8 py-4">
        <div className="h-5 w-20 rounded bg-slate-100 animate-pulse" />
        <div className="h-3 w-80 rounded bg-slate-100 animate-pulse mt-2" />
      </header>

      <div className="px-8 py-7 max-w-2xl space-y-5">
        {/* Summary recap */}
        <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-5 space-y-2">
          <div className="h-3 w-28 rounded bg-slate-100 animate-pulse" />
          <div className="h-4 w-full rounded bg-slate-100 animate-pulse" />
          <div className="h-4 w-3/4 rounded bg-slate-100 animate-pulse" />
        </div>

        {/* Form card */}
        <div className="bg-white rounded-xl border border-slate-100 p-6 space-y-6">
          {/* Per-transaction */}
          <section>
            <div className="h-4 w-48 rounded bg-slate-100 animate-pulse mb-2" />
            <div className="h-3 w-72 rounded bg-slate-100 animate-pulse mb-3" />
            <div className="flex flex-wrap gap-2 mb-3">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-7 w-14 rounded-lg bg-slate-100 animate-pulse"
                />
              ))}
            </div>
            <div className="h-10 w-full max-w-xs rounded-lg bg-slate-100 animate-pulse" />
          </section>

          {/* Monthly budget */}
          <section className="border-t border-slate-50 pt-5">
            <div className="h-4 w-32 rounded bg-slate-100 animate-pulse mb-2" />
            <div className="h-3 w-80 rounded bg-slate-100 animate-pulse mb-3" />
            <div className="flex flex-wrap gap-2 mb-3">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-7 w-16 rounded-lg bg-slate-100 animate-pulse"
                />
              ))}
            </div>
            <div className="h-10 w-full max-w-xs rounded-lg bg-slate-100 animate-pulse" />
          </section>

          {/* Merchant category locks */}
          <section className="border-t border-slate-50 pt-5">
            <div className="h-4 w-44 rounded bg-slate-100 animate-pulse mb-2" />
            <div className="h-3 w-full max-w-md rounded bg-slate-100 animate-pulse mb-3" />
            <div className="rounded-lg border border-slate-100 divide-y divide-slate-100">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-3">
                  <div className="h-4 w-4 rounded-full bg-slate-100 animate-pulse mt-1" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-4 w-40 rounded bg-slate-100 animate-pulse" />
                    <div className="h-3 w-64 rounded bg-slate-100 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Merchant exclusions */}
          <section className="border-t border-slate-50 pt-5">
            <div className="h-4 w-40 rounded bg-slate-100 animate-pulse mb-2" />
            <div className="h-3 w-full max-w-md rounded bg-slate-100 animate-pulse mb-3" />
            <div className="flex gap-2">
              <div className="flex-1 h-10 rounded-lg bg-slate-100 animate-pulse" />
              <div className="h-10 w-16 rounded-lg bg-slate-100 animate-pulse" />
            </div>
          </section>

          {/* Emergency stop */}
          <section className="border-t border-slate-50 pt-5">
            <div className="h-4 w-32 rounded bg-slate-100 animate-pulse mb-3" />
            <div className="h-16 w-full rounded-lg bg-slate-100 animate-pulse" />
          </section>

          {/* Save */}
          <div className="pt-2">
            <div className="h-10 w-28 rounded-lg bg-slate-100 animate-pulse" />
          </div>
        </div>
      </div>
    </main>
  );
}
