"use client";

/**
 * Onboarding setup banner shown on the Overview page until the user has
 * completed all three onboarding steps:
 *
 *   1. Connect a funding source
 *   2. Generate an MCP token
 *   3. Install Spendex in their agent (acknowledged via localStorage)
 *
 * The data on the first two steps is fetched server-side and passed in
 * as props (so the banner does not flash on initial paint). Step 3 is a
 * pure client-side flag — we cannot detect installation, only ask the
 * user to mark it done.
 *
 * The banner is fully self-dismissable. Once dismissed, we persist the
 * choice in localStorage so a returning user does not see it again.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

interface OnboardingBannerProps {
  hasFundingSource: boolean;
  hasMcpToken: boolean;
}

const STORAGE_KEY = "spendex.onboardingDismissed";
const STEP3_KEY = "spendex.onboardingStep3Done";

export default function OnboardingBanner({
  hasFundingSource,
  hasMcpToken,
}: OnboardingBannerProps) {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [step3Done, setStep3Done] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      setDismissed(window.localStorage.getItem(STORAGE_KEY) === "1");
      setStep3Done(window.localStorage.getItem(STEP3_KEY) === "1");
    } catch {
      // localStorage may be unavailable in private mode — fall through.
    }
  }, []);

  // Avoid hydration flicker: render nothing on the server pass.
  if (!mounted) return null;

  const completed =
    (hasFundingSource ? 1 : 0) + (hasMcpToken ? 1 : 0) + (step3Done ? 1 : 0);
  const total = 3;

  // Hide once everything is done or the user dismissed.
  if (dismissed || completed >= total) return null;

  function handleDismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
  }

  function markStep3Done() {
    setStep3Done(true);
    try {
      window.localStorage.setItem(STEP3_KEY, "1");
    } catch {
      // ignore
    }
  }

  const headline =
    completed === 0
      ? "Finish setup — 3 steps."
      : completed === total - 1
        ? "1 step left."
        : `${total - completed} steps left.`;

  // Compact two-line banner: row 1 is the headline + dismiss; row 2 is the
  // three step pills inline. Designed to take minimal vertical space so the
  // Overview's stats and chart remain the visual centre of the page.
  return (
    <div className="mb-4 rounded-xl border border-[#6D5BFF]/25 bg-gradient-to-r from-[#0D0F14] to-[#0a1322] px-4 py-3 text-white">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-xs font-semibold flex items-center gap-2">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[#6D5BFF]" />
          {headline}
          <span className="text-white/45 font-normal">
            {completed}/{total}
          </span>
        </p>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-[11px] font-medium text-white/40 hover:text-white/70 transition-colors shrink-0"
          aria-label="Dismiss onboarding banner"
        >
          Dismiss
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <CompactStep
          label="Connect funding"
          done={hasFundingSource}
          href="/dashboard/wallet"
        />
        <CompactStep
          label="Generate MCP token"
          done={hasMcpToken}
          href="/dashboard/tokens"
        />
        <CompactStep
          label="Install in agent"
          done={step3Done}
          href="/docs"
          onClick={step3Done ? undefined : markStep3Done}
        />
      </div>
    </div>
  );
}

function CompactStep({
  label,
  done,
  href,
  onClick,
}: {
  label: string;
  done: boolean;
  href: string;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
        done
          ? "bg-[#6D5BFF]/10 text-[#6D5BFF] border border-[#6D5BFF]/20"
          : "bg-white/5 text-white/80 border border-white/10 hover:bg-white/10"
      }`}
    >
      <span
        className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold shrink-0 ${
          done ? "bg-[#6D5BFF] text-[#0D0F14]" : "bg-white/15 text-white/70"
        }`}
        aria-hidden="true"
      >
        {done ? (
          <svg
            className="h-2 w-2"
            fill="none"
            viewBox="0 0 12 12"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path d="M2.5 6.5L5 9l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          "·"
        )}
      </span>
      <span className="truncate">{label}</span>
    </Link>
  );
}

