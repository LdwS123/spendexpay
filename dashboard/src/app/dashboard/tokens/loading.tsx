// Suspense boundary for /dashboard/tokens.
// Mirrors TokensClient: header, current-token card, regenerate hint.
export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading MCP tokens…</span>

      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4">
        <div className="h-5 w-32 rounded bg-slate-100 animate-pulse" />
        <div className="h-3 w-80 rounded bg-slate-100 animate-pulse mt-2" />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-2xl space-y-5">
        {/* Current token card */}
        <div className="bg-white rounded-xl border border-slate-100 p-6">
          <div className="h-4 w-36 rounded bg-slate-100 animate-pulse mb-1" />
          <div className="h-3 w-72 rounded bg-slate-100 animate-pulse mb-5" />

          <div className="rounded-lg border border-slate-100 bg-slate-50/40 p-4 flex items-center gap-3">
            <div className="flex-1 h-9 rounded bg-slate-100 animate-pulse" />
            <div className="h-9 w-20 rounded-lg bg-slate-100 animate-pulse" />
          </div>

          <div className="h-3 w-48 rounded bg-slate-100 animate-pulse mt-4" />
        </div>

        {/* Install snippet card */}
        <div className="bg-white rounded-xl border border-slate-100 p-6">
          <div className="h-4 w-44 rounded bg-slate-100 animate-pulse mb-1" />
          <div className="h-3 w-60 rounded bg-slate-100 animate-pulse mb-4" />
          <div className="h-20 w-full rounded-lg bg-slate-100 animate-pulse" />
        </div>
      </div>
    </main>
  );
}
