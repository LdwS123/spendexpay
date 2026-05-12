"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  alias: string;
}

/**
 * Compact copy-to-clipboard button for an email alias. Used inline in the
 * managed-accounts list cards and on the detail page.
 */
export default function CopyAlias({ alias }: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(alias);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked in insecure contexts — value stays on screen.
    }
  }

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 font-mono text-xs text-[#0a1220] bg-slate-50 border border-slate-100 rounded-md px-2.5 py-1.5 truncate">
        {alias}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? `${alias} copied to clipboard` : `Copy alias ${alias}`}
        className="text-[11px] font-semibold text-slate-700 hover:text-[#0a1220] border border-slate-200 hover:border-slate-300 bg-white rounded-md px-2.5 py-2 min-h-[44px] sm:min-h-0 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5b4]"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
