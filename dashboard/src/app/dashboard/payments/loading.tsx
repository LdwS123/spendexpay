// Suspense boundary for /dashboard/payments.
// Mirrors PaymentsClient: header, saved-method card, add-card prompt.
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading payment methods…</span>

      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4">
        <div className="h-5 w-44 rounded bg-slate-100 animate-pulse" />
        <div className="h-3 w-72 rounded bg-slate-100 animate-pulse mt-2" />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-2xl space-y-5">
        {/* Funding source card */}
        <div className="bg-white rounded-xl border border-slate-100 p-6">
          <div className="h-4 w-32 rounded bg-slate-100 animate-pulse mb-1" />
          <div className="h-3 w-60 rounded bg-slate-100 animate-pulse mb-5" />

          <div className="flex items-center gap-4 rounded-lg border border-slate-100 bg-slate-50/40 p-4">
            <div className="h-10 w-14 rounded-md bg-slate-100 animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-40 rounded bg-slate-100 animate-pulse" />
              <div className="h-3 w-28 rounded bg-slate-100 animate-pulse" />
            </div>
            <div className="h-7 w-20 rounded-lg bg-slate-100 animate-pulse" />
          </div>
        </div>

        {/* Secondary block */}
        <div className="bg-white rounded-xl border border-slate-100 p-6">
          <div className="h-4 w-36 rounded bg-slate-100 animate-pulse mb-1" />
          <div className="h-3 w-56 rounded bg-slate-100 animate-pulse mb-4" />
          <div className="h-9 w-44 rounded-lg bg-slate-100 animate-pulse" />
        </div>
      </div>
    </main>
  );
}
