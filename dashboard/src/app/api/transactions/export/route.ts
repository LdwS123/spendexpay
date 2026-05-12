/**
 * GET /api/transactions/export
 *
 * Stream the current user's transactions as a CSV file.
 *
 * Query params:
 *   from    — ISO date (inclusive lower bound on created_at). Optional.
 *   to      — ISO date (inclusive upper bound on created_at). Optional.
 *   service — service slug filter (e.g. "vercel"). Optional.
 *
 * Auth: derived server-side from the Supabase session cookie. A caller
 * cannot read another user's transactions by spoofing a query parameter.
 *
 * Hard cap of 10,000 rows. If the cap is hit, a trailing comment row is
 * appended ("Export limited to 10000 rows") so the consumer notices the
 * truncation even when opening the file in a spreadsheet.
 *
 * CSV escaping follows RFC 4180:
 *   - any field containing a comma, double-quote, CR or LF is wrapped in "..."
 *   - embedded double-quotes are doubled ("")
 *   - line terminator is CRLF
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const MAX_ROWS = 10000;

interface ExportRow {
  created_at: string;
  service: string | null;
  description: string | null;
  amount_usd: number | null;
  status: string | null;
  transaction_id: string | null;
  agent_id: string | null;
  merchant: string | null;
}

// RFC 4180 escape — wrap field in quotes if it contains a comma, quote,
// CR or LF, and double any embedded quotes.
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields: unknown[]): string {
  return fields.map(csvField).join(",");
}

function parseIsoBound(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function todayFilename(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `spendex-transactions-${yyyy}-${mm}-${dd}.csv`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const from = parseIsoBound(searchParams.get("from"));
  const to = parseIsoBound(searchParams.get("to"));
  const service = searchParams.get("service") ?? undefined;

  let client: ReturnType<typeof getAdminClient>;
  try {
    client = getAdminClient();
  } catch (err) {
    console.error("[api/transactions/export] Admin client unavailable:", err);
    return NextResponse.json(
      { error: "Database client unavailable" },
      { status: 500 }
    );
  }

  // We always select the same column set. `merchant` is optional in the
  // schema, so we tolerate its absence at the formatter layer.
  let query = client
    .from("audit_logs")
    .select(
      "created_at, service, description, amount_usd, status, transaction_id, agent_id, merchant"
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);

  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);
  if (service) query = query.eq("service", service);

  const { data, error } = await query;

  if (error) {
    // 42703 = column does not exist (e.g. merchant column missing). Retry
    // without the optional column so the export still works.
    if (error.code === "42703") {
      let fallback = client
        .from("audit_logs")
        .select(
          "created_at, service, description, amount_usd, status, transaction_id, agent_id"
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS);

      if (from) fallback = fallback.gte("created_at", from);
      if (to) fallback = fallback.lte("created_at", to);
      if (service) fallback = fallback.eq("service", service);

      const { data: fbData, error: fbError } = await fallback;
      if (fbError) {
        console.error("[api/transactions/export] Fallback query error:", fbError);
        return NextResponse.json(
          { error: "Failed to fetch transactions" },
          { status: 500 }
        );
      }
      return buildCsvResponse(
        (fbData ?? []).map((r) => ({ ...r, merchant: null })) as ExportRow[]
      );
    }
    console.error("[api/transactions/export] Query error:", error);
    return NextResponse.json(
      { error: "Failed to fetch transactions" },
      { status: 500 }
    );
  }

  return buildCsvResponse((data ?? []) as ExportRow[]);
}

function buildCsvResponse(rows: ExportRow[]): NextResponse {
  const HEADERS = [
    "Date",
    "Service",
    "Description",
    "Amount (USD)",
    "Status",
    "Transaction ID",
    "Agent ID",
    "Merchant",
  ];

  const lines: string[] = [];
  lines.push(csvRow(HEADERS));

  for (const r of rows) {
    lines.push(
      csvRow([
        r.created_at ?? "",
        r.service ?? "",
        r.description ?? "",
        r.amount_usd != null ? r.amount_usd.toFixed(2) : "",
        r.status ?? "",
        r.transaction_id ?? "",
        r.agent_id ?? "",
        r.merchant ?? "",
      ])
    );
  }

  if (rows.length >= MAX_ROWS) {
    // Trailing notice — kept on its own row so spreadsheets render it as
    // a single cell rather than confusing the column layout.
    lines.push(csvRow([`Export limited to ${MAX_ROWS} rows`]));
  }

  // RFC 4180 line terminator is CRLF.
  const body = lines.join("\r\n") + "\r\n";

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${todayFilename()}"`,
      "Cache-Control": "no-store",
    },
  });
}
