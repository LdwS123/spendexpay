"use client";

import { useState } from "react";

interface Props {
  hasToken: boolean;
  createdAt: string | null;
}

export default function TokensClient({ hasToken: initialHasToken, createdAt }: Props) {
  const [hasToken, setHasToken] = useState(initialHasToken);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tokens", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed to generate token");
        return;
      }
      setNewToken(json.token as string);
      setHasToken(true);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  async function revoke() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tokens", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed to revoke token");
        return;
      }
      setHasToken(false);
      setNewToken(null);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  function copy(val: string) {
    navigator.clipboard.writeText(val);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const createdDate = createdAt
    ? new Date(createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <main>
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[#0a1220]">MCP tokens</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Paste a token into your agent config to authorize payments.
          </p>
        </div>
        {!hasToken && (
          <button
            type="button"
            onClick={generate}
            disabled={loading}
            className="bg-[#070d18] hover:bg-[#0f1c30] disabled:opacity-50 text-white font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {loading ? "Generating…" : "Generate token"}
          </button>
        )}
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-3xl space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {/* One-time token reveal banner */}
        {newToken && (
          <div className="bg-[#00e5b4]/8 border border-[#00e5b4]/30 rounded-xl p-4">
            <p className="text-xs font-medium text-[#00a882] mb-2">
              New token — copy it now, it won&apos;t be shown again
            </p>
            <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg px-3 py-2.5">
              <code className="text-sm font-mono text-slate-800 flex-1 truncate">
                {newToken}
              </code>
              <button
                type="button"
                onClick={() => copy(newToken)}
                className="text-xs font-medium text-[#00e5b4] hover:text-[#00c49a] shrink-0 transition-colors"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {/* Token status card */}
        {!hasToken ? (
          <div className="bg-white rounded-xl border border-slate-100">
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center mb-4">
                <svg
                  className="w-5 h-5 text-slate-300"
                  fill="none"
                  viewBox="0 0 16 16"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <circle cx="6" cy="7" r="3.5" />
                  <path
                    d="M9 8.5l5.5 5.5M12 11.5l1.5 1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-600">No token</p>
              <p className="text-xs text-slate-400 mt-1">
                Generate a token and add it to your agent&apos;s MCP config.
              </p>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-100 divide-y divide-slate-50">
            <div className="flex items-center gap-4 px-5 py-4">
              <div className="flex-1 min-w-0">
                <code className="text-sm font-mono text-slate-700">
                  spx_••••••••••••••••
                </code>
                {createdDate && (
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Created {createdDate} · Never shown again
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={generate}
                  disabled={loading}
                  className="text-xs text-slate-400 hover:text-slate-600 font-medium transition-colors disabled:opacity-50"
                >
                  {loading ? "Working…" : "Rotate"}
                </button>
                <button
                  type="button"
                  onClick={revoke}
                  disabled={loading}
                  className="text-xs text-red-400 hover:text-red-600 font-medium transition-colors disabled:opacity-50"
                >
                  Revoke
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Usage snippet */}
        <div className="bg-[#070d18] rounded-xl p-5">
          <p className="text-[11px] font-semibold text-[#00e5b4] tracking-widest uppercase mb-3">
            Usage
          </p>
          <pre className="text-[10px] text-white/40 font-mono leading-relaxed whitespace-pre">
            {`// .claude/settings.json\n{\n  "mcpServers": {\n    "spendexpay": {\n      "command": "npx",\n      "args": ["-y", "@spendexpay/mcp"],\n      "env": { "SPENDEX_TOKEN": "spx_..." }\n    }\n  }\n}`}
          </pre>
        </div>
      </div>
    </main>
  );
}
