"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar — premium light aesthetic.
//
// Design references: Linear, Stripe Dashboard, Mercury, Ramp.
// - White background with a single subtle right border (slate-200).
// - Refined typography: workspace name in tracking-tight semibold,
//   "Agent finance" subtitle in uppercase tracking-widest muted.
// - Nav items use slate-600 / slate-900 hierarchy. Active state is
//   slate-100 bg + slate-900 text + teal icon (accent reserved for the
//   one element that truly identifies the active surface).
// - Keyboard hints (⌘1..⌘5) on hover — power-user signal without noise.
// - Mark: rounded square with a custom geometric glyph (not just "S").
// ─────────────────────────────────────────────────────────────────────────────

type NavItem = {
  label: string;
  href: string;
  shortcut: string;
  /** Icon stroke path inside a 16x16 viewBox. */
  icon: (active: boolean) => React.ReactNode;
};

const ICON_STROKE = 1.5;

function OverviewIcon({ active }: { active: boolean }) {
  // 2x2 grid — represents the overview cards
  return (
    <svg className="h-[16px] w-[16px] shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx={active ? 1.5 : 1} fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.18 : 0} />
    </svg>
  );
}

function WalletIcon() {
  // Subtle card shape with notch
  return (
    <svg className="h-[16px] w-[16px] shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE}>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.75" />
      <path d="M1.5 6.5h13" strokeLinecap="round" />
      <circle cx="11.5" cy="10" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ActivityIcon() {
  // Stacked rows with tiny right-side dots (representing tx feed)
  return (
    <svg className="h-[16px] w-[16px] shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE}>
      <path d="M2.5 4h7" strokeLinecap="round" />
      <circle cx="13" cy="4" r="0.85" fill="currentColor" stroke="none" />
      <path d="M2.5 8h7" strokeLinecap="round" />
      <circle cx="13" cy="8" r="0.85" fill="currentColor" stroke="none" />
      <path d="M2.5 12h7" strokeLinecap="round" />
      <circle cx="13" cy="12" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RulesIcon() {
  // Shield-like with horizontal limit line
  return (
    <svg className="h-[16px] w-[16px] shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE}>
      <path d="M8 2L2.5 4v4.5C2.5 11 5 13.2 8 14c3-0.8 5.5-3 5.5-5.5V4L8 2z" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M5.5 8h5" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  // Three horizontal slider knobs — settings/preferences feel, less generic than a gear
  return (
    <svg className="h-[16px] w-[16px] shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE}>
      <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
      <circle cx="5.5" cy="4" r="1.5" fill="white" />
      <circle cx="10" cy="8" r="1.5" fill="white" />
      <circle cx="7" cy="12" r="1.5" fill="white" />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { label: "Overview", href: "/dashboard", shortcut: "⌘1", icon: (active) => <OverviewIcon active={active} /> },
  { label: "Wallet", href: "/dashboard/wallet", shortcut: "⌘2", icon: () => <WalletIcon /> },
  { label: "Activity", href: "/dashboard/activity", shortcut: "⌘3", icon: () => <ActivityIcon /> },
  { label: "Rules", href: "/dashboard/rules", shortcut: "⌘4", icon: () => <RulesIcon /> },
  { label: "Settings", href: "/dashboard/settings", shortcut: "⌘5", icon: () => <SettingsIcon /> },
];

const ACTIVE_PREFIXES: Record<string, string[]> = {
  "/dashboard/wallet": ["/dashboard/wallet", "/dashboard/payments", "/dashboard/services"],
  "/dashboard/activity": ["/dashboard/activity", "/dashboard/transactions", "/dashboard/orders"],
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
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

interface SidebarProps {
  email: string;
}

export default function Sidebar({ email }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Keyboard shortcuts — Cmd/Ctrl + 1..5 to jump between top-level surfaces.
  // Skipped when typing in an input/textarea/contenteditable.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const idx = parseInt(e.key, 10);
      if (isNaN(idx) || idx < 1 || idx > NAV_ITEMS.length) return;
      e.preventDefault();
      router.push(NAV_ITEMS[idx - 1].href);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const initial = email.charAt(0).toUpperCase();
  const username = email.split("@")[0] ?? email;

  const navInner = (
    <>
      {/* Workspace header */}
      <div className="px-5 pt-5 pb-4 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2.5 group">
          {/* Custom mark — small rounded square with internal geometry */}
          <span className="relative flex h-7 w-7 items-center justify-center rounded-[7px] bg-[#070d18] overflow-hidden">
            <span className="absolute inset-0 bg-gradient-to-br from-[#00e5b4]/0 via-transparent to-[#00e5b4]/30" />
            <svg className="h-3.5 w-3.5 relative" viewBox="0 0 16 16" fill="none">
              <path d="M3 11.5C3 11.5 5 13 8 13C11 13 13 11.5 13 9.5C13 6 3 7 3 4C3 2 5 1 8 1C10.5 1 13 2.5 13 4.5" stroke="#00e5b4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold leading-tight tracking-tight text-slate-900">
              Spendex
            </span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400 mt-0.5">
              Agent finance
            </span>
          </span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="lg:hidden text-slate-400 hover:text-slate-700 p-1 -mr-1 rounded-md"
          aria-label="Close menu"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5}>
            <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Section label */}
      <div className="px-5 pt-4 pb-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Workspace
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3">
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const active = isActivePath(pathname, item.href);
            return (
              <li key={item.label}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`group relative flex items-center gap-3 rounded-md pl-3 pr-2 py-1.5 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5b4] focus-visible:ring-offset-2 ${
                    active
                      ? "bg-slate-100 text-slate-900 font-medium"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  {/* Tiny teal indicator dot at left edge when active */}
                  {active && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-[#00e5b4]" aria-hidden="true" />
                  )}
                  <span className={`shrink-0 transition-colors ${active ? "text-[#00b894]" : "text-slate-400 group-hover:text-slate-600"}`}>
                    {item.icon(active)}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className={`text-[10px] tabular-nums font-medium ${active ? "text-slate-500" : "text-slate-300 group-hover:text-slate-400"} opacity-0 group-hover:opacity-100 ${active ? "!opacity-100" : ""} transition-opacity`}>
                    {item.shortcut}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer — user + sign out */}
      <div className="border-t border-slate-100 mt-2">
        <div className="px-3 py-3">
          <div className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-slate-50 transition-colors group">
            <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-slate-700 text-[11px] font-semibold shrink-0 ring-1 ring-slate-200/60">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-slate-900 truncate leading-tight">
                {username}
              </p>
              <p className="text-[10px] text-slate-500 truncate leading-tight mt-0.5">
                Free plan
              </p>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              aria-label="Sign out"
              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700 p-1 -mr-1 rounded transition-all"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5}>
                <path d="M6 3H3.5A1.5 1.5 0 002 4.5v7A1.5 1.5 0 003.5 13H6M10 11l3-3-3-3M13 8H6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between bg-white px-4 h-14 border-b border-slate-200">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 font-semibold text-slate-900 tracking-tight text-base"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-[#070d18]">
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
              <path d="M3 11.5C3 11.5 5 13 8 13C11 13 13 11.5 13 9.5C13 6 3 7 3 4C3 2 5 1 8 1C10.5 1 13 2.5 13 4.5" stroke="#00e5b4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          Spendex
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-slate-500 hover:text-slate-900 p-1.5 -mr-1.5 rounded-md hover:bg-slate-50"
          aria-label="Open menu"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 shrink-0 bg-white border-r border-slate-200 flex-col sticky top-0 h-screen">
        {navInner}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute left-0 top-0 bottom-0 w-72 bg-white flex flex-col shadow-2xl">
            {navInner}
          </aside>
        </div>
      )}
    </>
  );
}
