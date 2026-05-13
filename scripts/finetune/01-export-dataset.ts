#!/usr/bin/env tsx
/**
 * 01-export-dataset.ts — pull real classifications from production Supabase
 * and write them as JSONL for downstream fine-tuning.
 *
 * The `intent_classifications` table holds every Haiku decision the live MCP
 * server has cached over the last 7 days (the cache TTL). For fine-tuning we
 * keep a longer window — the production rows are the highest-quality signal
 * we have because they reflect actual agent behaviour, not synthetic data.
 *
 * Inputs (env):
 *   SUPABASE_URL              — required, your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — required, service-role key
 *   DAYS                      — optional, lookback window in days (default 30)
 *   OUT                       — optional, output path (default ./data/real-classifications.jsonl)
 *
 * Output format (one JSON object per line):
 *   {
 *     "service": "vercel",
 *     "description": "Upgrade my-app to Pro",
 *     "amount_usd": 20,
 *     "category": "dev_tools",
 *     "urgency": "medium",
 *     "risk_score": 5,
 *     "reasoning": "..."
 *   }
 *
 * Run:
 *   tsx scripts/finetune/01-export-dataset.ts
 *   DAYS=90 tsx scripts/finetune/01-export-dataset.ts
 */

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface ExportedRow {
  service: string;
  description: string;
  amount_usd: number;
  category: string;
  urgency: string;
  risk_score: number;
  reasoning: string;
}

// The `description` field isn't currently persisted on intent_classifications
// (the cache only keeps the hash). We pull the closest fields available and
// best-effort reconstruct a description from the cached reasoning when no
// `description` column exists in the user's deployment.
interface RawRow {
  service: string | null;
  description: string | null;
  amount_usd: number | null;
  category: string | null;
  urgency: string | null;
  risk_score: number | null;
  reasoning: string | null;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const supabaseKey =
    process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? process.env["SUPABASE_SERVICE_KEY"];

  if (!supabaseUrl || !supabaseKey) {
    console.error(
      "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Set them in your env or .env file before running."
    );
    process.exit(1);
  }

  const days = Number.parseInt(process.env["DAYS"] ?? "30", 10);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`DAYS must be a positive integer, got '${process.env["DAYS"]}'`);
    process.exit(1);
  }

  const out = resolve(process.env["OUT"] ?? "./data/real-classifications.jsonl");

  const supabase = createClient(supabaseUrl, supabaseKey);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.error(
    `[export-dataset] querying intent_classifications since ${since} (last ${days}d)`
  );

  // Pull in pages so we don't blow up on large datasets. Supabase's PostgREST
  // caps at 1000 rows per request by default; iterate range() until empty.
  const PAGE = 1000;
  const rows: ExportedRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("intent_classifications")
      .select(
        "service, description, amount_usd, category, urgency, risk_score, reasoning, created_at"
      )
      .gte("created_at", since)
      .neq("category", "unknown")
      .range(from, from + PAGE - 1)
      .order("created_at", { ascending: false });

    if (error) {
      console.error(
        `[export-dataset] supabase error at offset ${from}: ${error.message}. ` +
        `If the column "description" does not exist, run with the migration applied.`
      );
      process.exit(1);
    }
    if (!data || data.length === 0) break;

    for (const r of data as RawRow[]) {
      // Skip rows that don't have the minimum fields we need for training.
      if (
        !r.service ||
        !r.category ||
        !r.urgency ||
        r.risk_score === null ||
        r.amount_usd === null
      ) {
        continue;
      }
      rows.push({
        service: r.service,
        // If the deployment doesn't persist the raw description, fall back
        // to the reasoning as a soft proxy — it usually contains the key
        // terms the model considered.
        description: r.description ?? r.reasoning ?? "",
        amount_usd: r.amount_usd,
        category: r.category,
        urgency: r.urgency,
        risk_score: r.risk_score,
        reasoning: r.reasoning ?? "",
      });
    }

    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Stats: distribution per category, makes class imbalance visible before
  // training so the operator can decide whether to oversample minorities.
  const dist: Record<string, number> = {};
  for (const r of rows) dist[r.category] = (dist[r.category] ?? 0) + 1;

  mkdirSync(dirname(out), { recursive: true });
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(out, jsonl);

  console.error(`[export-dataset] wrote ${rows.length} rows → ${out}`);
  console.error("[export-dataset] category distribution:");
  for (const [cat, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    const pct = ((n / Math.max(rows.length, 1)) * 100).toFixed(1);
    console.error(`  ${cat.padEnd(14)} ${String(n).padStart(5)} (${pct}%)`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[export-dataset] fatal: ${msg}`);
  process.exit(1);
});
