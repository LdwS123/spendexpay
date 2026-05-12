import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import DecisionButtons from "./DecisionButtons";

export const dynamic = "force-dynamic";

// ─── types ───────────────────────────────────────────────────────────────────

type ConsentStatus =
  | "pending"
  | "approved"
  | "declined"
  | "expired"
  | "cancelled"
  | string;

interface ConsentRequestRow {
  id: string;
  user_id: string;
  service: string | null;
  action: string | null;
  amount_usd: number | null;
  context: Record<string, unknown> | null;
  options: string[] | null;
  status: ConsentStatus;
  decision: string | null;
  decision_made_at: string | null;
  expires_at: string | null;
  created_at: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function serviceLabel(raw: string | null | undefined): string {
  if (!raw) return "—";
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

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
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

function StatusBadge({ status }: { status: ConsentStatus }) {
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        Pending
      </span>
    );
  }
  if (status === "approved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#00e5b4]/15 text-[#00a882]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#00a882]" />
        Approved
      </span>
    );
  }
  if (status === "declined") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-100">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        Declined
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        Expired
      </span>
    );
  }
  if (status === "cancelled") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        Cancelled
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

async function loadConsent(
  consentId: string,
  userId: string
): Promise<ConsentRequestRow | null> {
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch {
    return null;
  }

  try {
    const { data, error } = await admin
      .from("consent_requests")
      .select(
        "id, user_id, service, action, amount_usd, context, options, status, decision, decision_made_at, expires_at, created_at"
      )
      .eq("id", consentId)
      .maybeSingle();

    if (error) {
      if (error.code === "42P01") return null;
      console.error("[consents/[id]] query error:", error);
      return null;
    }
    const row = (data ?? null) as ConsentRequestRow | null;
    if (!row || row.user_id !== userId) return null;
    return row;
  } catch (err) {
    console.error("[consents/[id]] unexpected error:", err);
    return null;
  }
}

// ─── page ────────────────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ConsentDetailPage({ params }: PageProps) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const consent = await loadConsent(id, user.id);
  if (!consent) {
    notFound();
  }

  const now = Date.now();
  const isExpired =
    consent.status === "pending" &&
    !!consent.expires_at &&
    new Date(consent.expires_at).getTime() <= now;

  const effectiveStatus: ConsentStatus = isExpired ? "expired" : consent.status;
  const isStillPending = consent.status === "pending" && !isExpired;

  const ctx =
    consent.context && typeof consent.context === "object" ? consent.context : null;
  const ctxEntries = ctx
    ? Object.entries(ctx).filter(([, v]) => v !== null && v !== "")
    : [];

  const amountLabel =
    consent.amount_usd && consent.amount_usd > 0
      ? `€${consent.amount_usd.toFixed(2)}`
      : "—";

  return (
    <main>
      <header className="bg-white border-b border-slate-100 px-4 sm:px-8 py-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/dashboard/consents"
            className="text-[11px] font-medium text-slate-400 hover:text-slate-600 transition-colors inline-flex items-center gap-1"
          >
            ← All consents
          </Link>
          <h1 className="text-lg font-semibold text-[#0a1220] mt-1">
            {consent.action ?? "Consent request"}{" "}
            <span className="text-slate-400 font-normal">
              · {serviceLabel(consent.service)}
            </span>
          </h1>
        </div>
        <StatusBadge status={effectiveStatus} />
      </header>

      <div className="px-4 sm:px-8 py-7 max-w-3xl space-y-6">
        {/* ── Request details ── */}
        <section className="bg-white border border-slate-100 rounded-xl p-6">
          <p className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase mb-4">
            Request details
          </p>

          <dl className="space-y-3 text-sm">
            <Row label="Action" value={consent.action ?? "—"} />
            <Row label="Service" value={serviceLabel(consent.service)} />
            <Row label="Amount" value={amountLabel} />
            <Row
              label="Options"
              value={
                consent.options && consent.options.length > 0
                  ? consent.options.join(", ")
                  : "—"
              }
            />
            <Row label="Requested" value={formatDateTime(consent.created_at)} />
            <Row label="Expires" value={formatDateTime(consent.expires_at)} />
          </dl>

          {ctxEntries.length > 0 && (
            <div className="mt-5 pt-5 border-t border-slate-100">
              <p className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase mb-3">
                Context
              </p>
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-3 space-y-1.5 text-xs">
                {ctxEntries.map(([k, v]) => (
                  <div key={k} className="flex items-start gap-3">
                    <span className="text-slate-400 shrink-0 min-w-[80px]">
                      {k}
                    </span>
                    <span className="text-slate-700 break-all">
                      {typeof v === "string" || typeof v === "number"
                        ? String(v)
                        : JSON.stringify(v)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── Decision ── */}
        <section className="bg-white border border-slate-100 rounded-xl p-6">
          <p className="text-[11px] font-semibold text-slate-400 tracking-widest uppercase mb-4">
            Your decision
          </p>

          {isStillPending ? (
            <DecisionButtons
              consentId={consent.id}
              options={consent.options ?? []}
            />
          ) : isExpired ? (
            <p className="text-sm text-slate-500">
              This request expired before a decision was made.
            </p>
          ) : consent.decision ? (
            <p className="text-sm text-[#0a1220]">
              Decided:{" "}
              <span className="font-semibold">{consent.decision}</span>
              {consent.decision_made_at && (
                <span className="text-slate-400">
                  {" "}
                  at {formatDateTime(consent.decision_made_at)}
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-slate-500">
              No decision recorded for this request.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-4">
      <dt className="text-xs font-medium text-slate-400 min-w-[80px] pt-0.5">
        {label}
      </dt>
      <dd className="text-sm text-[#0a1220] break-words">{value}</dd>
    </div>
  );
}
