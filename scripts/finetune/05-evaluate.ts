#!/usr/bin/env tsx
/**
 * 05-evaluate.ts — run the test set through three backends and write a
 * markdown report comparing accuracy.
 *
 * Backends compared:
 *
 *   - "haiku"           Claude Haiku 4.5 (production baseline)
 *   - "ollama-base"     Untuned Ollama model (OLLAMA_BASE_MODEL env)
 *   - "ollama-tuned"    Fine-tuned Ollama model (OLLAMA_TUNED_MODEL env)
 *
 * Metrics:
 *   - Category exact-match accuracy
 *   - Urgency exact-match accuracy
 *   - Risk-score accuracy (predicted within +/-10 of label)
 *   - Per-category accuracy table
 *   - Confusion matrix (predicted vs. label) per backend
 *
 * Inputs (env):
 *   ANTHROPIC_API_KEY      — required for the "haiku" baseline
 *   OLLAMA_BASE_URL        — default http://localhost:11434
 *   OLLAMA_BASE_MODEL      — default llama3.2:3b
 *   OLLAMA_TUNED_MODEL     — default spendex-classifier:v1
 *   TEST_FILE              — default ./data/test.jsonl
 *   OUT                    — default ./data/eval-report.md
 *   MAX_ROWS               — optional cap on test rows (useful while debugging)
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface TestRow {
  service: string;
  description: string;
  amount_usd: number;
  category: string;
  urgency: "low" | "medium" | "high";
  risk_score: number;
  reasoning?: string;
}

interface Prediction {
  category: string;
  urgency: "low" | "medium" | "high" | "unknown";
  risk_score: number;
  ok: boolean;
}

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const CATEGORIES = [
  "dev_tools",
  "shopping",
  "subscription",
  "food",
  "travel",
  "gambling",
  "crypto",
  "gift_cards",
  "cash_advance",
  "unknown",
];

function loadTest(path: string): TestRow[] {
  const text = readFileSync(path, "utf8");
  const rows: TestRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        messages?: Array<{ role: string; content: string }>;
      };
      if (!obj.messages || obj.messages.length < 2) continue;
      const userMsg = obj.messages[0]!.content;
      const asstMsg = obj.messages[1]!.content;
      const serviceMatch = /service:\s*(.+)/.exec(userMsg);
      const amountMatch = /amount_usd:\s*([\d.]+)/.exec(userMsg);
      const descMatch = /description:\s*(.+)/.exec(userMsg);
      if (!serviceMatch || !amountMatch || !descMatch) continue;
      const label = JSON.parse(asstMsg) as TestRow;
      rows.push({
        service: serviceMatch[1]!.trim(),
        description: descMatch[1]!.trim(),
        amount_usd: Number.parseFloat(amountMatch[1]!),
        category: label.category,
        urgency: label.urgency,
        risk_score: label.risk_score,
        reasoning: label.reasoning,
      });
    } catch {
      // skip
    }
  }
  return rows;
}

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}
interface TextBlock {
  type: "text";
  text: string;
}
type ContentBlock = ToolUseBlock | TextBlock;

const HAIKU_SYSTEM =
  "You are a purchase-intent classifier. Categories: dev_tools, shopping, " +
  "subscription, food, travel, gambling, crypto, gift_cards, cash_advance, " +
  "unknown. Urgency: low|medium|high. risk_score: 0-100.";

const HAIKU_TOOL = {
  name: "submit_classification",
  description: "Submit the classification.",
  input_schema: {
    type: "object" as const,
    properties: {
      category: { type: "string" },
      subcategory: { type: ["string", "null"] },
      urgency: { type: "string", enum: ["low", "medium", "high"] },
      risk_score: { type: "integer", minimum: 0, maximum: 100 },
      reasoning: { type: "string" },
    },
    required: ["category", "urgency", "risk_score", "reasoning"],
  },
};

async function predictHaiku(
  client: Anthropic,
  row: TestRow
): Promise<Prediction> {
  try {
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 400,
      system: HAIKU_SYSTEM,
      tools: [HAIKU_TOOL],
      tool_choice: { type: "tool", name: HAIKU_TOOL.name },
      messages: [
        {
          role: "user",
          content:
            `service: ${row.service}\namount_usd: ${row.amount_usd}\ndescription: ${row.description}`,
        },
      ],
    });
    for (const block of resp.content as ContentBlock[]) {
      if (block.type !== "tool_use" || block.name !== HAIKU_TOOL.name) continue;
      return readPrediction(block.input);
    }
    return badPred();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[eval] haiku error: ${msg}`);
    return badPred();
  }
}

async function predictOllama(
  baseUrl: string,
  model: string,
  row: TestRow
): Promise<Prediction> {
  try {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        format: "json",
        stream: false,
        options: { temperature: 0.1, num_predict: 400 },
        messages: [
          { role: "system", content: HAIKU_SYSTEM },
          {
            role: "user",
            content:
              `service: ${row.service}\namount_usd: ${row.amount_usd}\n` +
              `description: ${row.description}\n\n` +
              "Respond with a single JSON object: " +
              "category, subcategory, urgency, risk_score, reasoning.",
          },
        ],
      }),
    });
    if (!resp.ok) return badPred();
    const payload = (await resp.json()) as {
      message?: { content?: string };
    };
    const content = payload.message?.content;
    if (typeof content !== "string") return badPred();
    const obj = JSON.parse(content) as Record<string, unknown>;
    return readPrediction(obj);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[eval] ollama error (${model}): ${msg}`);
    return badPred();
  }
}

function readPrediction(input: Record<string, unknown>): Prediction {
  const cat = input["category"];
  const urg = input["urgency"];
  const rs = input["risk_score"];
  if (typeof cat !== "string") return badPred();
  if (urg !== "low" && urg !== "medium" && urg !== "high") return badPred();
  if (typeof rs !== "number") return badPred();
  return {
    category: cat,
    urgency: urg,
    risk_score: Math.max(0, Math.min(100, Math.round(rs))),
    ok: true,
  };
}

function badPred(): Prediction {
  return { category: "unknown", urgency: "unknown", risk_score: 50, ok: false };
}

interface BackendStats {
  name: string;
  total: number;
  errors: number;
  categoryHits: number;
  urgencyHits: number;
  riskHits: number;
  perCategoryTotal: Record<string, number>;
  perCategoryHit: Record<string, number>;
  confusion: Record<string, Record<string, number>>;
}

function newStats(name: string): BackendStats {
  return {
    name,
    total: 0,
    errors: 0,
    categoryHits: 0,
    urgencyHits: 0,
    riskHits: 0,
    perCategoryTotal: {},
    perCategoryHit: {},
    confusion: {},
  };
}

function record(stats: BackendStats, label: TestRow, pred: Prediction): void {
  stats.total += 1;
  if (!pred.ok) stats.errors += 1;
  stats.perCategoryTotal[label.category] =
    (stats.perCategoryTotal[label.category] ?? 0) + 1;
  if (pred.category === label.category) {
    stats.categoryHits += 1;
    stats.perCategoryHit[label.category] =
      (stats.perCategoryHit[label.category] ?? 0) + 1;
  }
  if (pred.urgency === label.urgency) stats.urgencyHits += 1;
  if (Math.abs(pred.risk_score - label.risk_score) <= 10) stats.riskHits += 1;
  const a = CATEGORIES.includes(label.category) ? label.category : "unknown";
  const p = CATEGORIES.includes(pred.category) ? pred.category : "unknown";
  stats.confusion[a] ??= {};
  stats.confusion[a]![p] = (stats.confusion[a]![p] ?? 0) + 1;
}

function pct(num: number, den: number): string {
  if (den === 0) return "-";
  return ((num / den) * 100).toFixed(1) + "%";
}

function renderReport(allStats: BackendStats[]): string {
  const lines: string[] = [];
  lines.push("# Intent classifier evaluation report");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Backend | N | Errors | Category acc | Urgency acc | Risk +/-10 |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const s of allStats) {
    lines.push(
      `| ${s.name} | ${s.total} | ${s.errors} | ${pct(s.categoryHits, s.total)} | ` +
        `${pct(s.urgencyHits, s.total)} | ${pct(s.riskHits, s.total)} |`
    );
  }
  lines.push("");
  for (const s of allStats) {
    lines.push(`## ${s.name} - per-category accuracy`);
    lines.push("");
    lines.push("| Category | N | Hits | Accuracy |");
    lines.push("|---|---:|---:|---:|");
    for (const cat of CATEGORIES) {
      const total = s.perCategoryTotal[cat] ?? 0;
      const hits = s.perCategoryHit[cat] ?? 0;
      if (total === 0) continue;
      lines.push(`| ${cat} | ${total} | ${hits} | ${pct(hits, total)} |`);
    }
    lines.push("");
    lines.push(`## ${s.name} - confusion matrix (rows=actual, cols=predicted)`);
    lines.push("");
    lines.push("| | " + CATEGORIES.join(" | ") + " |");
    lines.push("|---|" + CATEGORIES.map(() => "---:").join("|") + "|");
    for (const a of CATEGORIES) {
      const row = s.confusion[a] ?? {};
      const cells = CATEGORIES.map((p) => String(row[p] ?? 0));
      lines.push(`| **${a}** | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || apiKey.length === 0) {
    console.error("Missing ANTHROPIC_API_KEY (needed for Haiku baseline).");
    process.exit(1);
  }
  const testPath = resolve(process.env["TEST_FILE"] ?? "./data/test.jsonl");
  const outPath = resolve(process.env["OUT"] ?? "./data/eval-report.md");
  const ollamaBase = (process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434").replace(
    /\/+$/,
    ""
  );
  const baseModel = process.env["OLLAMA_BASE_MODEL"] ?? "llama3.2:3b";
  const tunedModel = process.env["OLLAMA_TUNED_MODEL"] ?? "spendex-classifier:v1";

  let rows = loadTest(testPath);
  if (process.env["MAX_ROWS"]) {
    const cap = Number.parseInt(process.env["MAX_ROWS"], 10);
    if (Number.isFinite(cap) && cap > 0) rows = rows.slice(0, cap);
  }
  if (rows.length === 0) {
    console.error(`[eval] no rows in ${testPath} - run 03-prepare-mlx-data.ts first.`);
    process.exit(1);
  }
  console.error(`[eval] loaded ${rows.length} test rows from ${testPath}`);

  const client = new Anthropic({ apiKey });
  const haikuStats = newStats("haiku-4.5 (baseline)");
  const baseStats = newStats(`ollama-base (${baseModel})`);
  const tunedStats = newStats(`ollama-tuned (${tunedModel})`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if ((i + 1) % 25 === 0 || i + 1 === rows.length) {
      process.stderr.write(`\r[eval] row ${i + 1}/${rows.length}`);
    }
    const [haiku, base, tuned] = await Promise.all([
      predictHaiku(client, row),
      predictOllama(ollamaBase, baseModel, row),
      predictOllama(ollamaBase, tunedModel, row),
    ]);
    record(haikuStats, row, haiku);
    record(baseStats, row, base);
    record(tunedStats, row, tuned);
  }
  process.stderr.write("\n");

  const report = renderReport([haikuStats, baseStats, tunedStats]);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report);
  console.error(`[eval] wrote ${outPath}`);
  console.error("[eval] summary:");
  for (const s of [haikuStats, baseStats, tunedStats]) {
    console.error(
      `  ${s.name.padEnd(36)} cat=${pct(s.categoryHits, s.total)} ` +
        `urg=${pct(s.urgencyHits, s.total)} risk+/-10=${pct(s.riskHits, s.total)} ` +
        `errors=${s.errors}`
    );
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[eval] fatal: ${msg}`);
  process.exit(1);
});
