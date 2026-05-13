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
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Access
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0D0F14]">
              MCP tokens
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Issue or rotate the credential your agent uses to call Spendex.
          </p>
        </div>
        {!hasToken && (
          <button
            type="button"
            onClick={generate}
            disabled={loading}
              className="rounded-lg bg-[#0D0F14] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1a1f2c] disabled:opacity-50"
          >
              {loading ? "Generating..." : "Generate token"}
          </button>
        )}
        </div>
      </header>

      <div className="max-w-3xl space-y-4 px-4 py-7 sm:px-8">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {/* One-time token reveal banner */}
        {newToken && (
          <div className="rounded-xl border border-[#6D5BFF]/30 bg-[#6D5BFF]/8 p-4">
            <p className="text-xs font-medium text-[#3B82F6] mb-2">
              New token — copy it now, it won&apos;t be shown again
            </p>
            <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg px-3 py-2.5">
              <code className="text-sm font-mono text-slate-800 flex-1 truncate">
                {newToken}
              </code>
              <button
                type="button"
                onClick={() => copy(newToken)}
                aria-label={copied ? "Token copied to clipboard" : "Copy MCP token"}
                className="text-xs font-semibold text-[#6D5BFF] hover:text-[#3B82F6] shrink-0 transition-colors px-2 py-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6D5BFF]"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {/* Token status */}
        {!hasToken ? (
          <div className="overflow-hidden rounded-xl border border-slate-200/70 bg-white">
            <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-slate-100 bg-slate-50">
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
              <p className="text-sm font-medium text-slate-700">No active token</p>
              <p className="mt-1 text-xs text-slate-500">
                Generate a token and add it to your agent&apos;s MCP config.
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/70 bg-white">
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
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={generate}
                  disabled={loading}
                  className="text-xs text-slate-500 hover:text-slate-700 font-medium transition-colors disabled:opacity-50 px-2 py-2 min-h-[44px] sm:min-h-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6D5BFF]"
                >
                  {loading ? "Working..." : "Rotate"}
                </button>
                <button
                  type="button"
                  onClick={revoke}
                  disabled={loading}
                  className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors disabled:opacity-50 px-2 py-2 min-h-[44px] sm:min-h-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  Revoke
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Usage snippet */}
        <div className="rounded-xl bg-[#0D0F14] p-5">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#6D5BFF]">
            Cursor / Claude config
          </p>
          <pre className="text-[10px] text-white/40 font-mono leading-relaxed whitespace-pre">
            {`// .mcp.json\n{\n  "mcpServers": {\n    "spendex": {\n      "command": "npx",\n      "args": ["-y", "@spendexai/mcp"],\n      "env": { "SPENDEX_TOKEN": "spx_..." }\n    }\n  }\n}`}
          </pre>
        </div>
      </div>
    </main>
  );
}
