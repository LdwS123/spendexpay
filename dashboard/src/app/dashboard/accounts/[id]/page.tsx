import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import CopyAlias from "../CopyAlias";
import RevealPassword from "./RevealPassword";
import AccountActions from "./AccountActions";

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
  is_primary: boolean | null;
  created_at: string;
}

interface InboundEmailRow {
  id: string;
  managed_account_id: string;
  subject: string | null;
  from_address: string | null;
  received_at: string;
  verification_link: string | null;
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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }) +
    " · " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

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

async function loadAccount(
  accountId: string,
  userId: string
): Promise<{ account: ManagedAccountRow | null; inboundEmails: InboundEmailRow[] }> {
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch {
    return { account: null, inboundEmails: [] };
  }

  let account: ManagedAccountRow | null = null;
  try {
    const { data, error } = await admin
      .from("managed_accounts")
      .select(
        "id, user_id, service, email_alias, status, external_account_id, is_primary, created_at"
      )
      .eq("id", accountId)
      .maybeSingle();

    if (error) {
      if (error.code === "42P01") {
        return { account: null, inboundEmails: [] };
      }
      console.error("[accounts/[id]] query error:", error);
      return { account: null, inboundEmails: [] };
    }
    account = (data ?? null) as ManagedAccountRow | null;
  } catch (err) {
    console.error("[accounts/[id]] unexpected error:", err);
    return { account: null, inboundEmails: [] };
  }

  if (!account || account.user_id !== userId) {
    return { account: null, inboundEmails: [] };
  }

  // Inbound emails — fetch last 10 for this account.
  let inboundEmails: InboundEmailRow[] = [];
  try {
    const { data, error } = await admin
      .from("inbound_emails")
      .select(
        "id, managed_account_id, subject, from_address, received_at, verification_link"
      )
      .eq("managed_account_id", account.id)
      .order("received_at", { ascending: false })
      .limit(10);

    if (error) {
      if (error.code !== "42P01") {
        console.error("[accounts/[id]] inbound_emails error:", error);
      }
    } else {
      inboundEmails = (data ?? []) as InboundEmailRow[];
    }
  } catch (err) {
    console.error("[accounts/[id]] inbound_emails unexpected error:", err);
  }

  return { account, inboundEmails };
}

// ─── page ────────────────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AccountDetailPage({ params }: PageProps) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { account, inboundEmails } = await loadAccount(id, user.id);

  if (!account) {
    notFound();
  }

  const statusValue =
    typeof account.status === "string" && account.status.length > 0
      ? account.status
      : "pending_signup";
  const isRevoked = statusValue === "revoked";

  return (
    <main>
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/dashboard/accounts"
            className="text-[11px] font-medium text-slate-400 hover:text-slate-600 transition-colors inline-flex items-center gap-1"
          >
            ← All managed accounts
          </Link>
          <h1 className="text-lg font-semibold text-[#0a1220] mt-1">
            {serviceLabel(account.service)} managed account
          </h1>
        </div>
        <StatusBadge status={statusValue} />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-3xl space-y-6">
        {/* Credentials */}
        <section className="bg-white border border-slate-100 rounded-xl p-6">
          <p className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase mb-4">
            Credentials
          </p>

          <div className="space-y-4">
            <div>
              <p className="text-[11px] font-medium text-slate-500 mb-1.5">Email</p>
              {account.email_alias ? (
                <CopyAlias alias={account.email_alias} />
              ) : (
                <p className="text-xs text-slate-400">No email alias on file.</p>
              )}
              <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                Spendex forwards verification emails for this alias to the inbox
                below so your agent can complete sign-up flows on its own.
              </p>
            </div>

            <div className="pt-4 border-t border-slate-100">
              <p className="text-[11px] font-medium text-slate-500 mb-1.5">
                Password
              </p>
              <RevealPassword accountId={account.id} disabled={isRevoked} />
            </div>

            {account.external_account_id && (
              <div className="pt-4 border-t border-slate-100">
                <p className="text-[11px] font-medium text-slate-500 mb-1.5">
                  External account ID
                </p>
                <code className="font-mono text-xs text-[#0a1220] bg-slate-50 border border-slate-100 rounded-md px-2.5 py-1.5 inline-block break-all">
                  {account.external_account_id}
                </code>
              </div>
            )}
          </div>
        </section>

        {/* Inbound emails */}
        <section className="bg-white border border-slate-100 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <p className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase">
              Inbound emails
            </p>
            <span className="text-[11px] text-slate-400 tabular-nums">
              {inboundEmails.length === 10 ? "Last 10" : inboundEmails.length}
            </span>
          </div>

          {inboundEmails.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <p className="text-sm text-slate-500">No emails received yet.</p>
              <p className="text-xs text-slate-400 mt-1.5 max-w-md mx-auto leading-relaxed">
                Verification and notification emails to{" "}
                <span className="font-mono">{account.email_alias ?? "the alias"}</span>{" "}
                will appear here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-50">
              {inboundEmails.map((email) => (
                <li
                  key={email.id}
                  className="px-6 py-3.5 flex items-start gap-4 hover:bg-slate-50/60 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[#0a1220] truncate">
                      {email.subject ?? "(no subject)"}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                      from {email.from_address ?? "unknown"} ·{" "}
                      {formatDateTime(email.received_at)}
                    </p>
                  </div>
                  {email.verification_link && (
                    <a
                      href={email.verification_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-semibold text-[#00a882] hover:text-[#00e5b4] transition-colors shrink-0"
                    >
                      Open link →
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Actions */}
        <section className="bg-white border border-slate-100 rounded-xl p-6">
          <p className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase mb-4">
            Actions
          </p>
          <AccountActions
            accountId={account.id}
            isRevoked={isRevoked}
            isPrimary={account.is_primary ?? false}
          />
        </section>
      </div>
    </main>
  );
}
