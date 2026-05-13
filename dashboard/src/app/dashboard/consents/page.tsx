import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";
import ConsentsClient, { type ConsentRequestRow } from "./ConsentsClient";

export const dynamic = "force-dynamic";

// ─── data fetching ───────────────────────────────────────────────────────────

async function loadConsents(
  userId: string
): Promise<{ pending: ConsentRequestRow[]; history: ConsentRequestRow[] }> {
  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch {
    return { pending: [], history: [] };
  }

  let rows: ConsentRequestRow[] = [];
  try {
    const { data, error } = await admin
      .from("consent_requests")
      .select(
        "id, user_id, service, action, amount_usd, context, options, status, decision, decision_made_at, expires_at, created_at"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      if (error.code === "42P01") {
        return { pending: [], history: [] };
      }
      console.error("[dashboard/consents] query error:", error);
      return { pending: [], history: [] };
    }
    rows = (data ?? []) as ConsentRequestRow[];
  } catch (err) {
    console.error("[dashboard/consents] unexpected error:", err);
    return { pending: [], history: [] };
  }

  const now = Date.now();
  const pending: ConsentRequestRow[] = [];
  const history: ConsentRequestRow[] = [];
  for (const row of rows) {
    const notExpired =
      !row.expires_at || new Date(row.expires_at).getTime() > now;
    if (row.status === "pending" && notExpired) {
      pending.push(row);
    } else {
      history.push(row);
    }
  }

  return { pending, history };
}

// ─── page ────────────────────────────────────────────────────────────────────

export default async function ConsentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { pending, history } = await loadConsents(user.id);

  return (
    <main>
      <header className="border-b border-slate-200/70 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
        <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Control
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0D0F14]">
              Approvals
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Human decisions required before Spendex continues a sensitive action.
          </p>
        </div>
        <Link
          href="/dashboard/consents/preferences"
          className="text-xs font-semibold text-[#3B82F6] hover:text-[#6D5BFF] transition-colors"
        >
          Preferences →
        </Link>
        </div>
      </header>

      <div className="max-w-6xl space-y-8 px-4 py-7 sm:px-8">
        <ConsentsClient
          initialPending={pending}
          initialHistory={history}
          userId={user.id}
        />
      </div>
    </main>
  );
}
