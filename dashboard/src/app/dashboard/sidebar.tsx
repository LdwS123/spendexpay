"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// ─────────────────────────────────────────────────────────────────────────────
// Navigation model
//
// We deliberately keep the user-facing surface to FIVE items, ordered by the
// new operator's likely first session:
//   1. Overview  — where everything is at a glance.
//   2. Wallet    — the virtual card + the funding source that feeds it.
//   3. Activity  — every charge + every order, in one feed.
//   4. Rules     — guardrails the agent enforces before spending.
//   5. Settings  — identity & access (profile, tokens, managed accounts,
//                  consent preferences, 2FA, danger zone) lives under tabs.
//
// Pages such as /dashboard/subscriptions, /dashboard/refunds,
// /dashboard/reports, and /status remain accessible via direct URL — they
// are intentionally not in the nav for the V1 / VC-first surface.
// ─────────────────────────────────────────────────────────────────────────────

type NavItem = { label: string; href: string; d: string };

const NAV_ITEMS: NavItem[] = [
  {
    label: "Overview",
    href: "/dashboard",
    d: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z",
  },
  {
    label: "Wallet",
    href: "/dashboard/wallet",
    d: "M1.5 4.5h13v8h-13zM1.5 7.5h13M11 10.5h2",
  },
  {
    label: "Activity",
    href: "/dashboard/activity",
    d: "M3 4h10M3 8h10M3 12h6",
  },
  {
    label: "Rules",
    href: "/dashboard/rules",
    d: "M2 4h12M2 8h12M2 12h12M10 4a1.5 1.5 0 110 0M5 8a1.5 1.5 0 110 0M11 12a1.5 1.5 0 110 0",
  },
  {
    label: "Settings",
    href: "/dashboard/settings",
    d: "M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  },
];

// Group every legacy URL we still want to honour into the right top-level
// nav entry, so the "active" highlight tracks even when the user lands on a
// deep link that used to be its own sidebar item.
const ACTIVE_PREFIXES: Record<string, string[]> = {
  "/dashboard/wallet": ["/dashboard/wallet", "/dashboard/payments", "/dashboard/services"],
  "/dashboard/activity": [
    "/dashboard/activity",
    "/dashboard/transactions",
    "/dashboard/orders",
  ],
  "/dashboard/settings": [
    "/dashboard/settings",
    "/dashboard/tokens",
    "/dashboard/accounts",
    "/dashboard/consents",
  ],
};

function isActivePath(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  const prefixes = ACTIVE_PREFIXES[href] ?? [href];
  return prefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

interface SidebarProps {
  email: string;
}

export default function Sidebar({ email }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Auto-close drawer when route changes
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll when drawer is open on mobile
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  // Show just the first letter of the email address as the avatar.
  const initial = email.charAt(0).toUpperCase();

  const navInner = (
    <>
      <div className="px-4 py-4 border-b border-white/6 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-3 text-white">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#00e5b4] text-sm font-black text-[#070d18]">
            S
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-tight tracking-tight">
              Spendex
            </span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
              Agent finance
            </span>
          </span>
        </Link>
        {/* Close button — mobile only */}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="lg:hidden text-white/50 hover:text-white p-1 -mr-1"
          aria-label="Close menu"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5">
        <div className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = isActivePath(pathname, item.href);
            return (
              <Link
                key={item.label}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5b4] focus-visible:ring-offset-2 focus-visible:ring-offset-[#070d18] ${
                  active
                    ? "bg-white/[0.09] text-white shadow-[inset_2px_0_0_#00e5b4]"
                    : "text-white/62 hover:bg-white/[0.045] hover:text-white"
                }`}
              >
                <svg
                  className={`h-4 w-4 shrink-0 ${active ? "text-[#00e5b4]" : "text-white/36"}`}
                  fill="none"
                  viewBox="0 0 16 16"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path d={item.d} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-white/6 px-3 py-4">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="w-7 h-7 rounded-full bg-[#00e5b4]/12 flex items-center justify-center text-[#00e5b4] text-xs font-semibold shrink-0">
            {initial}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-white/80 truncate">{email}</p>
            <p className="text-[11px] text-white/42">Operator</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="w-full mt-1 text-[11px] text-white/70 hover:text-white px-3 py-1.5 text-left rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5b4] focus-visible:ring-offset-2 focus-visible:ring-offset-[#070d18]"
        >
          Sign out
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar with hamburger — visible <lg only */}
      <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between bg-[#070d18] px-4 h-14 border-b border-white/6">
        <Link
          href="/dashboard"
          className="font-semibold text-white tracking-tight text-base"
        >
          Spendex
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-white/70 hover:text-white p-1 -mr-1"
          aria-label="Open menu"
        >
          <svg
            className="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.75}
          >
            <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Desktop sidebar — visible lg+ */}
      <aside className="hidden lg:flex w-60 shrink-0 bg-[#070d18] flex-col sticky top-0 h-screen">
        {navInner}
      </aside>

      {/* Mobile drawer — visible <lg only when open */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* Drawer panel */}
          <aside className="absolute left-0 top-0 bottom-0 w-64 bg-[#070d18] flex flex-col shadow-2xl">
            {navInner}
          </aside>
        </div>
      )}
    </>
  );
}
