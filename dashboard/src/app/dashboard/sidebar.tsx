"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const NAV = [
  { label: "Overview",        href: "/dashboard",              d: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" },
  { label: "Transactions",    href: "/dashboard/transactions", d: "M3 4h10M3 8h10M3 12h6" },
  { label: "Subscriptions",   href: "/dashboard/subscriptions", d: "M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5v3.5l2.5 2.5" },
  { label: "Orders",          href: "/dashboard/orders",       d: "M3 5h10l-1 8H4L3 5zM3 5l-.5-2h-1M6 5V3.5a2 2 0 014 0V5" },
  { label: "Funding source",  href: "/dashboard/payments",     d: "M1.5 3.5h13v9h-13zM1.5 6.5h13" },
  { label: "Wallet",          href: "/dashboard/services",     d: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM10 8.5l-2.5 4h3.5L8.5 16" },
  { label: "Managed accounts", href: "/dashboard/accounts",    d: "M5 6a2 2 0 100-4 2 2 0 000 4zM11 7.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM1.5 13c0-1.9 1.6-3.5 3.5-3.5s3.5 1.6 3.5 3.5M9 13c0-1.4 1.1-2.5 2.5-2.5S14 11.6 14 13" },
  { label: "Consents",        href: "/dashboard/consents",     d: "M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM5 8l2 2 4-4" },
  { label: "MCP tokens",      href: "/dashboard/tokens",       d: "M3 9a4 4 0 107 0M9.5 9.5l4 4M11 12l1.5 1.5" },
  { label: "Rules",           href: "/dashboard/rules",        d: "M2 4h12M2 8h12M2 12h12M10 4a1.5 1.5 0 110 0M5 8a1.5 1.5 0 110 0M11 12a1.5 1.5 0 110 0" },
  { label: "Settings",        href: "/dashboard/settings",     d: "M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" },
];

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
      <div className="px-5 py-5 border-b border-white/5 flex items-center justify-between">
        <Link href="/" className="font-bold text-white tracking-tight text-base">
          Spendex <span className="text-[#00e5b4]">Pay</span>
        </Link>
        {/* Close button — mobile only */}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="lg:hidden text-white/50 hover:text-white p-1 -mr-1"
          aria-label="Close menu"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5}>
            <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.label}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5b4] focus-visible:ring-offset-2 focus-visible:ring-offset-[#070d18] ${
                active ? "bg-white/8 text-white font-medium" : "text-white/70 hover:text-white hover:bg-white/4"
              }`}
            >
              <svg className={`w-4 h-4 shrink-0 ${active ? "text-[#00e5b4]" : ""}`} fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5}>
                <path d={item.d} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 py-4 border-t border-white/5">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="w-7 h-7 rounded-full bg-[#00e5b4]/15 flex items-center justify-center text-[#00e5b4] text-xs font-semibold shrink-0">
            {initial}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-white/80 truncate">{email}</p>
            <p className="text-[11px] text-white/60">Free plan</p>
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
      <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between bg-[#070d18] px-4 h-14 border-b border-white/5">
        <Link href="/" className="font-bold text-white tracking-tight text-base">
          Spendex <span className="text-[#00e5b4]">Pay</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-white/70 hover:text-white p-1 -mr-1"
          aria-label="Open menu"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
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
