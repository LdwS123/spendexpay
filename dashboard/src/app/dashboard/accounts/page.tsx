import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import CopyAlias from "./CopyAlias";

export const dynamic = "force-dynamic";

// ─── types ───────────────────────────────────────────────────────────────────

type AccountStatus = "active" | "pending_signup" | "failed" | "revoked";

interface ManagedAccountRow {
  id: string;
  user_id: string;
  service: string;
  email_alias: string | null;
  status: AccountStatus | string | null;
  external_account_id: string | null;
  created_at: string;
}

interface InboundCount {
  managed_account_id: string;
  count: number;
}

interface ManagedAccountWithCount extends ManagedAccountRow {
  inboundCount: number;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function serviceLabel(raw: string): string {
  const map: Record<string, string> = {
    vercel: "Vercel",
    modal: "Modal",
    openai: "OpenAI",
    anthropic: "Anthropic",
    railway: "Railway",
    fly: "Fly.io",
    flyio: "Fly.io",
    render: "Render",
    netlify: "Netlify",
    github: "GitHub",
  };
  return map[raw.toLowerCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "Created just now";
  if (min < 60) return `Created ${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Created ${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `Created ${day} day${day === 1 ? "" : "s"} ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `Created ${month} month${month === 1 ? "" : "s"} ago`;
  const year = Math.floor(day / 365);
  return `Created ${year} year${year === 1 ? "" : "s"} ago`;
}

// ─── service icon (same conventions as ServicesClient.tsx) ───────────────────

function ServiceLogo({ service }: { service: string }) {
  const s = service.toLowerCase();

  if (s === "vercel") {
    return (
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 512 512" aria-hidden="true">
        <path d="M256 48L496 464H16L256 48z" />
      </svg>
    );
  }
  if (s === "modal") {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <path d="M5 8h6M8 5v6" strokeLinecap="round" />
      </svg>
    );
  }
  if (s === "openai" || s === "anthropic") {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M5.5 8a2.5 2.5 0 015 0M8 5.5a2.5 2.5 0 010 5" strokeLinecap="round" />
      </svg>
    );
  }
  if (s === "railway") {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (s === "fly" || s === "flyio") {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path d="M3 13L8 3l5 10" strokeLinejoin="round" />
        <path d="M5.5 9h5" strokeLinecap="round" />
      </svg>
    );
  }
  if (s === "render") {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path d="M3 3h10v10H3z" />
        <path d="M6 6l4 4M10 6l-4 4" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <rect x="2" y="4" width="12" height="9" rx="1.5" />
      <path d="M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1" />
    </svg>
  );
}

// ─── status badge ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#00e5b4]/15 text-[#00a882]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#00a882]" />
        Active
      </span>
    );
  }
  if (status === "pending_signup") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        Pending signup
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-100">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        Failed
      </span>
    );
  }
  if (status === "revoked") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        Revoked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-100">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      {status}
    </span>
  );
}

// ─── data fetching ───────────────────────────────────────────────────────────

async function loadAccounts(
  userId: string
): Promise<{ accounts: ManagedAccountWithCount[]; tableMissing: boolean }> {
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch {
    // Dev mode / no service key — render empty state instead of 500.
    return { accounts: [], tableMissing: true };
  }

  // 1) Load managed_accounts for the user.
  let accountRows: ManagedAccountRow[] = [];
  try {
    const { data, error } = await admin
      .from("managed_accounts")
      .select(
        "id, user_id, service, email_alias, status, external_account_id, created_at"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      // Postgres error 42P01 = relation does not exist (table not yet created
      // by the migration agent). Treat gracefully as empty state.
      if (error.code === "42P01") {
        return { accounts: [], tableMissing: true };
      }
      console.error("[dashboard/accounts] managed_accounts query error:", error);
      return { accounts: [], tableMissing: false };
    }
    accountRows = (data ?? []) as ManagedAccountRow[];
  } catch (err) {
    console.error("[dashboard/accounts] managed_accounts unexpected error:", err);
    return { accounts: [], tableMissing: false };
  }

  if (accountRows.length === 0) {
    return { accounts: [], tableMissing: false };
  }

  // 2) Count inbound emails per managed_account.
  const counts = new Map<string, number>();
  try {
    const { data, error } = await admin
      .from("inbound_emails")
      .select("managed_account_id")
      .in(
        "managed_account_id",
        accountRows.map((r) => r.id)
      );

    if (error) {
      if (error.code !== "42P01") {
        console.error("[dashboard/accounts] inbound_emails query error:", error);
      }
      // Fall through with empty counts — render accounts without stats.
    } else {
      for (const row of (data ?? []) as InboundCount[]) {
        const key = row.managed_account_id;
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  } catch (err) {
    console.error("[dashboard/accounts] inbound_emails unexpected error:", err);
  }

  const accounts: ManagedAccountWithCount[] = accountRows.map((r) => ({
    ...r,
    inboundCount: counts.get(r.id) ?? 0,
  }));

  return { accounts, tableMissing: false };
}

// ─── page ────────────────────────────────────────────────────────────────────

export default async function AccountsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { accounts } = await loadAccounts(user.id);

  return (
    <main>
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Access
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0a1220]">
            Managed accounts
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            External service accounts created through Spendex, with credentials and billing state.
          </p>
        </div>
      </header>

      <div className="max-w-6xl px-4 py-7 sm:px-8">
        {accounts.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {accounts.map((acc) => (
              <AccountCard key={acc.id} account={acc} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="bg-white border border-dashed border-slate-200 rounded-2xl p-10 text-center">
      <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center mb-4 mx-auto">
        <svg
          className="w-5 h-5 text-slate-300"
          fill="none"
          viewBox="0 0 16 16"
          stroke="currentColor"
          strokeWidth={1.5}
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="2.5" />
          <path d="M2 13c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5" strokeLinecap="round" />
          <path d="M10 4a2 2 0 010 4M14 13c0-1.7-1.2-3-3-3.3" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-sm font-medium text-slate-600">No managed accounts yet</p>
      <p className="text-xs text-slate-400 mt-1.5 max-w-md mx-auto leading-relaxed">
        Accounts created through signup flows appear here with status, credentials,
        and linked billing activity.
      </p>
    </div>
  );
}

function AccountCard({ account }: { account: ManagedAccountWithCount }) {
  const statusValue =
    typeof account.status === "string" && account.status.length > 0
      ? account.status
      : "pending_signup";

  return (
    <div className="bg-white border border-slate-100 rounded-xl p-5 flex flex-col gap-4 hover:border-slate-200 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center text-[#0a1220] shrink-0">
            <ServiceLogo service={account.service} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#0a1220] truncate">
              {serviceLabel(account.service)}
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {relativeTime(account.created_at)}
            </p>
          </div>
        </div>
        <StatusBadge status={statusValue} />
      </div>

      {account.email_alias && (
        <div>
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
            Email alias
          </p>
          <CopyAlias alias={account.email_alias} />
        </div>
      )}

      <div className="flex items-center justify-between pt-3 border-t border-slate-100">
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <svg
            className="w-3.5 h-3.5 text-slate-400"
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <rect x="2" y="3" width="12" height="10" rx="1.5" />
            <path d="M2 5l6 4 6-4" strokeLinejoin="round" />
          </svg>
          <span className="tabular-nums">
            {account.inboundCount} inbound email
            {account.inboundCount === 1 ? "" : "s"}
          </span>
        </div>
        <Link
          href={`/dashboard/accounts/${account.id}`}
          className="text-xs font-semibold text-[#00a882] hover:text-[#00e5b4] transition-colors"
        >
          View details →
        </Link>
      </div>
    </div>
  );
}
