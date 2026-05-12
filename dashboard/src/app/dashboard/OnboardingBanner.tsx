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
      ? "Welcome to Spendex Pay. Complete your setup in 3 steps:"
      : completed === total - 1
        ? "Almost there: 1 step left"
        : `Setup in progress — ${total - completed} steps left`;

  return (
    <div className="mb-5 rounded-xl border border-[#00e5b4]/30 bg-gradient-to-br from-[#070d18] via-[#0a1322] to-[#0e1a2d] px-5 py-4 text-white">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#00e5b4]/15 text-[#00e5b4]">
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 16 16"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <path
                  d="M8 2C8 2 4.5 4 4 8c-.25 2 .5 3.5 1.5 4.5M8 2c0 0 3.5 2 4 6 .25 2-.5 3.5-1.5 4.5M8 2v10"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <p className="text-sm font-semibold">{headline}</p>
          </div>
          <p className="mt-1 ml-10 text-[11px] text-white/50">
            {completed} of {total} complete
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-[11px] font-medium text-white/40 hover:text-white/70 transition-colors shrink-0"
          aria-label="Dismiss onboarding banner"
        >
          Dismiss
        </button>
      </div>

      {/* Progress bar */}
      <div className="mt-3 ml-10 mr-2 h-1 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full bg-[#00e5b4] transition-all duration-300"
          style={{ width: `${(completed / total) * 100}%` }}
        />
      </div>

      <ol className="mt-4 ml-10 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Step
          number={1}
          label="Connect funding source"
          done={hasFundingSource}
          href="/dashboard/payments"
        />
        <Step
          number={2}
          label="Generate MCP token"
          done={hasMcpToken}
          href="/dashboard/tokens"
        />
        <Step
          number={3}
          label="Install in your agent"
          done={step3Done}
          href="/docs"
          onClick={step3Done ? undefined : markStep3Done}
        />
      </ol>
    </div>
  );
}

function Step({
  number,
  label,
  done,
  href,
  onClick,
}: {
  number: number;
  label: string;
  done: boolean;
  href: string;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
        done
          ? "bg-[#00e5b4]/10 text-[#00e5b4] border border-[#00e5b4]/20"
          : "bg-white/5 text-white/80 border border-white/10 hover:bg-white/10"
      }`}
    >
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0 ${
          done ? "bg-[#00e5b4] text-[#070d18]" : "bg-white/10 text-white/70"
        }`}
        aria-hidden="true"
      >
        {done ? (
          <svg
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 12 12"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path d="M2.5 6.5L5 9l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          number
        )}
      </span>
      <span className="truncate">{label}</span>
    </Link>
  );
}
