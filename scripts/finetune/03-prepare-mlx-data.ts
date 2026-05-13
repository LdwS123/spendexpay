#!/usr/bin/env tsx
/**
 * 03-prepare-mlx-data.ts — merge real + synthetic JSONL, shuffle, split
 * 80/10/10, and re-format as the chat-style JSONL that mlx-lm expects.
 *
 * mlx-lm's --data flag points at a directory containing train.jsonl,
 * valid.jsonl, test.jsonl — exactly the names we emit.
 *
 * Input format (each line, from 01 + 02):
 *   { service, description, amount_usd, category, urgency, risk_score,
 *     reasoning, subcategory? }
 *
 * Output format (each line, mlx-lm chat schema):
 *   { "messages": [
 *       {"role": "user",      "content": "<user prompt>"},
 *       {"role": "assistant", "content": "<JSON string of the label>"}
 *   ]}
 *
 * The assistant's content is the stringified JSON object exactly as the
 * production Ollama backend expects to parse. This trains the student to
 * emit the same shape `normalizeClassification()` is already validating
 * against — no parser changes needed when switching backends.
 *
 * Inputs (env):
 *   REAL      — optional, default ./data/real-classifications.jsonl
 *   SYNTH     — optional, default ./data/synthetic-classifications.jsonl
 *   OUT_DIR   — optional, default ./data
 *   SEED      — optional, default 42 (shuffle seed for reproducibility)
 *   MAX_ROWS  — optional, cap on combined rows (default: no cap)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

interface RawRow {
  service: string;
  description: string;
  amount_usd: number;
  category: string;
  urgency: "low" | "medium" | "high";
  risk_score: number;
  reasoning: string;
  subcategory?: string | null;
}

interface MlxChatRow {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

// Deterministic shuffle (Mulberry32) so re-running with the same SEED gives
// the same train/valid/test split. Critical for reproducing eval numbers.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

function loadJsonl(path: string): RawRow[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const rows: RawRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as RawRow;
      if (
        typeof obj.service === "string" &&
        typeof obj.description === "string" &&
        typeof obj.amount_usd === "number" &&
        typeof obj.category === "string" &&
        (obj.urgency === "low" || obj.urgency === "medium" || obj.urgency === "high") &&
        typeof obj.risk_score === "number" &&
        typeof obj.reasoning === "string"
      ) {
        rows.push(obj);
      }
    } catch {
      // skip malformed lines silently — synthesis can drop a partial write
    }
  }
  return rows;
}

function toMlxChat(row: RawRow): MlxChatRow {
  // Keep the user prompt identical to what the production server sends,
  // including the JSON-output instruction. The Ollama backend at runtime
  // sends this exact prefix; training on the same prefix tightens the
  // distribution match.
  const user =
    `service: ${row.service}\n` +
    `amount_usd: ${row.amount_usd}\n` +
    `description: ${row.description}\n\n` +
    "Respond with a single JSON object with fields: " +
    "category, subcategory, urgency, risk_score, reasoning.";
  const assistant = JSON.stringify({
    category: row.category,
    subcategory: row.subcategory ?? null,
    urgency: row.urgency,
    risk_score: row.risk_score,
    reasoning: row.reasoning,
  });
  return {
    messages: [
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ],
  };
}

function writeJsonl(path: string, rows: MlxChatRow[]): void {
  const out = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(path, out);
}

function main(): void {
  const realPath = resolve(process.env["REAL"] ?? "./data/real-classifications.jsonl");
  const synthPath = resolve(process.env["SYNTH"] ?? "./data/synthetic-classifications.jsonl");
  const outDir = resolve(process.env["OUT_DIR"] ?? "./data");
  const seed = Number.parseInt(process.env["SEED"] ?? "42", 10);
  const maxRows = process.env["MAX_ROWS"]
    ? Number.parseInt(process.env["MAX_ROWS"], 10)
    : null;

  const real = loadJsonl(realPath);
  const synth = loadJsonl(synthPath);
  console.error(`[prepare] loaded real=${real.length} synth=${synth.length}`);
  if (real.length === 0 && synth.length === 0) {
    console.error("[prepare] no input data — run 01-export and/or 02-synthesize first.");
    process.exit(1);
  }

  let combined: RawRow[] = real.concat(synth);
  combined = shuffle(combined, mulberry32(seed));
  if (maxRows !== null && combined.length > maxRows) {
    combined = combined.slice(0, maxRows);
  }

  // 80/10/10. We compute boundaries by floor to avoid off-by-one issues
  // when the row count isn't divisible by 10.
  const n = combined.length;
  const nTrain = Math.floor(n * 0.8);
  const nValid = Math.floor(n * 0.1);
  // Test gets whatever's left so we never silently drop a row.
  const train = combined.slice(0, nTrain).map(toMlxChat);
  const valid = combined.slice(nTrain, nTrain + nValid).map(toMlxChat);
  const test = combined.slice(nTrain + nValid).map(toMlxChat);

  mkdirSync(outDir, { recursive: true });
  writeJsonl(resolve(outDir, "train.jsonl"), train);
  writeJsonl(resolve(outDir, "valid.jsonl"), valid);
  writeJsonl(resolve(outDir, "test.jsonl"), test);

  console.error(
    `[prepare] wrote ${train.length}/${valid.length}/${test.length} ` +
    `(train/valid/test) into ${outDir}`
  );
  console.error(
    "[prepare] next: bash scripts/finetune/04-finetune.sh"
  );
}

main();
