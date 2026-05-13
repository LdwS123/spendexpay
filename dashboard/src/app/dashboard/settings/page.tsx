import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ProfileSection from "./ProfileSection";
import TwoFactorSection from "./TwoFactorSection";
import DangerZoneSection from "./DangerZoneSection";

// ─────────────────────────────────────────────────────────────────────────────
// Settings — single page, multiple tabs.
//
// The V2 sidebar collapsed Profile, MCP tokens, Managed accounts, and
// Consent preferences into "Settings". To avoid duplicating the body of
// every legacy page we render a tab nav and link each tab to the matching
// existing surface — except the Profile / 2FA / Danger zone tab, which
// renders inline because it is the canonical "Settings" content.
//
// The legacy URLs (/dashboard/tokens, /dashboard/accounts,
// /dashboard/consents/preferences) remain accessible directly as well —
// the tab links point straight at them.
// ─────────────────────────────────────────────────────────────────────────────

type SettingsTab =
  | "profile"
  | "tokens"
  | "accounts"
  | "consents"
  | "security";

interface PageProps {
  searchParams: Promise<{ tab?: string }>;
}

function isTab(value: string | undefined): value is SettingsTab {
  return (
    value === "profile" ||
    value === "tokens" ||
    value === "accounts" ||
    value === "consents" ||
    value === "security"
  );
}

export default async function SettingsPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { tab: rawTab } = await searchParams;
  const tab: SettingsTab = isTab(rawTab) ? rawTab : "profile";

  return (
    <main>
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          Account
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0D0F14]">
          Settings
        </h1>
        <p className="mt-1 text-xs text-slate-500">
          Profile, agent access, managed accounts, and consent preferences.
        </p>
      </header>

      <div className="max-w-4xl px-4 py-7 sm:px-8">
        {/* ── Tabs ── */}
        <nav
          role="tablist"
          aria-label="Settings sections"
          className="mb-6 flex flex-wrap gap-1 border-b border-slate-200/70"
        >
          <SettingsTabLink
            href="/dashboard/settings"
            label="Profile"
            active={tab === "profile"}
          />
          <SettingsTabLink
            href="/dashboard/settings?tab=tokens"
            label="MCP tokens"
            active={tab === "tokens"}
          />
          <SettingsTabLink
            href="/dashboard/settings?tab=accounts"
            label="Managed accounts"
            active={tab === "accounts"}
          />
          <SettingsTabLink
            href="/dashboard/settings?tab=consents"
            label="Consent preferences"
            active={tab === "consents"}
          />
          <SettingsTabLink
            href="/dashboard/settings?tab=security"
            label="Security"
            active={tab === "security"}
          />
        </nav>

        {tab === "profile" && (
          <div className="space-y-5">
            <ProfileSection />
          </div>
        )}

        {tab === "security" && (
          <div className="space-y-5">
            <TwoFactorSection />
            <DangerZoneSection />
          </div>
        )}

        {tab === "tokens" && (
          <TabRedirectCard
            heading="MCP tokens"
            body="Generate or rotate the credential your agent uses to call Spendex."
            href="/dashboard/tokens"
            cta="Open MCP tokens"
          />
        )}

        {tab === "accounts" && (
          <TabRedirectCard
            heading="Managed accounts"
            body="External service accounts Spendex has created on your behalf."
            href="/dashboard/accounts"
            cta="Open managed accounts"
          />
        )}

        {tab === "consents" && (
          <TabRedirectCard
            heading="Consent preferences"
            body="Decide when your agent should ask, and when it can act on its own."
            href="/dashboard/consents/preferences"
            cta="Open consent preferences"
          />
        )}
      </div>
    </main>
  );
}

function SettingsTabLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={`-mb-px px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-[#6D5BFF] text-[#0D0F14]"
          : "border-transparent text-slate-500 hover:text-[#0D0F14]"
      }`}
    >
      {label}
    </Link>
  );
}

function TabRedirectCard({
  heading,
  body,
  href,
  cta,
}: {
  heading: string;
  body: string;
  href: string;
  cta: string;
}) {
  // The legacy pages have rich, client-heavy bodies (Stripe Elements, push
  // subscription, etc.). Rather than copy-paste that code into Settings we
  // render a "go here" card. The Settings tab remains the canonical entry,
  // and the legacy page handles the heavy lifting.
  return (
    <div className="rounded-xl border border-slate-100 bg-white px-6 py-7">
      <h2 className="text-sm font-semibold text-[#0D0F14]">{heading}</h2>
      <p className="mt-1 text-xs text-slate-500 max-w-xl leading-relaxed">
        {body}
      </p>
      <Link
        href={href}
        className="inline-block mt-4 rounded-lg bg-[#0D0F14] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1a1f2c]"
      >
        {cta} →
      </Link>
    </div>
  );
}
