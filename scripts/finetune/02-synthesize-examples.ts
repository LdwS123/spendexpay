#!/usr/bin/env tsx
/**
 * 02-synthesize-examples.ts — generate N synthetic (input, classification)
 * pairs by asking Haiku to invent plausible merchants/descriptions and then
 * label them via the same classifier the live MCP server uses.
 *
 * This is distillation: the small student (Llama 3.2 3B) learns to imitate
 * the big teacher (Haiku 4.5) on synthesised inputs that cover every
 * category proportionally.
 *
 * Inputs (env):
 *   ANTHROPIC_API_KEY — required
 *   COUNT             — optional, total examples to generate (default 5000)
 *   CONCURRENCY       — optional, parallel Haiku calls (default 10)
 *   OUT               — optional, default ./data/synthetic-classifications.jsonl
 *
 * Why two-step (generate → classify) and not one big prompt:
 *   - We want labels that match what the production classifier would emit
 *     for the same (service, description, amount) tuple, not what a chat
 *     completion would freelance. Reusing the production tool-use schema
 *     keeps the synthetic set on-distribution.
 *
 * Cost estimate (rough, May 2025 pricing):
 *   - Haiku 4.5: $0.80 / MTok input, $4.00 / MTok output.
 *   - Per example: ~200 tokens in + ~100 tokens out across both calls.
 *   - 5000 examples ≈ $0.10–0.30 total. Cheap.
 */

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";

interface ClassifiedExample {
  service: string;
  description: string;
  amount_usd: number;
  category: string;
  subcategory: string | null;
  urgency: "low" | "medium" | "high";
  risk_score: number;
  reasoning: string;
}

const MODEL_ID = "claude-haiku-4-5-20251001";

// Same 10 categories the production classifier uses. The generator is told
// to spread examples roughly evenly across them so the fine-tuning set
// isn't dominated by whichever category appears most in the wild.
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
] as const;

const GENERATOR_SYSTEM =
  "You invent realistic purchase intents an AI agent might encounter. " +
  "Be specific (real merchant names, plausible amounts, real-sounding " +
  "task descriptions). Avoid trademark slogans. Each call returns ONE " +
  "purchase. Vary amounts wildly: $1.99 to $9,500.";

const GENERATOR_TOOL = {
  name: "submit_purchase_intent",
  description: "Return ONE invented purchase intent.",
  input_schema: {
    type: "object" as const,
    properties: {
      service: {
        type: "string",
        description: "Merchant or service name (e.g. 'vercel', 'amazon').",
      },
      description: {
        type: "string",
        description: "Short free-text description of what the agent is buying.",
      },
      amount_usd: {
        type: "number",
        description: "Charge amount in USD. May be fractional.",
      },
    },
    required: ["service", "description", "amount_usd"],
  },
};

const CLASSIFIER_SYSTEM =
  "You are a purchase-intent classifier. Given a merchant, description, " +
  "and amount, output a structured classification. Categories: dev_tools, " +
  "shopping, subscription, food, travel, gambling, crypto, gift_cards, " +
  "cash_advance, unknown. Urgency: low | medium | high. risk_score: 0-100.";

const CLASSIFIER_TOOL = {
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

// ---------------------------------------------------------------------------
// Tool-use parsing
// ---------------------------------------------------------------------------

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

function findToolUse(blocks: ContentBlock[], name: string): Record<string, unknown> | null {
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === name) return b.input;
  }
  return null;
}

// ---------------------------------------------------------------------------
// One synthesis step: generate → classify → return assembled row.
// ---------------------------------------------------------------------------

async function synthesizeOne(
  client: Anthropic,
  targetCategory: string
): Promise<ClassifiedExample | null> {
  try {
    // 1) Generate a purchase intent biased toward `targetCategory`.
    const genResp = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 200,
      system: GENERATOR_SYSTEM,
      tools: [GENERATOR_TOOL],
      tool_choice: { type: "tool", name: GENERATOR_TOOL.name },
      messages: [
        {
          role: "user",
          content:
            `Invent ONE purchase intent that would clearly fit the category "${targetCategory}". ` +
            "Pick a real-sounding merchant and a specific use case.",
        },
      ],
    });

    const genInput = findToolUse(genResp.content as ContentBlock[], GENERATOR_TOOL.name);
    if (!genInput) return null;
    const service = genInput["service"];
    const description = genInput["description"];
    const amount = genInput["amount_usd"];
    if (
      typeof service !== "string" ||
      typeof description !== "string" ||
      typeof amount !== "number"
    ) {
      return null;
    }

    // 2) Classify it with the same prompt the production server uses.
    const clsResp = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 400,
      system: CLASSIFIER_SYSTEM,
      tools: [CLASSIFIER_TOOL],
      tool_choice: { type: "tool", name: CLASSIFIER_TOOL.name },
      messages: [
        {
          role: "user",
          content: `service: ${service}\namount_usd: ${amount}\ndescription: ${description}`,
        },
      ],
    });

    const clsInput = findToolUse(clsResp.content as ContentBlock[], CLASSIFIER_TOOL.name);
    if (!clsInput) return null;
    const category = clsInput["category"];
    const urgency = clsInput["urgency"];
    const riskScore = clsInput["risk_score"];
    const reasoning = clsInput["reasoning"];
    const subcategoryRaw = clsInput["subcategory"];

    if (typeof category !== "string") return null;
    if (urgency !== "low" && urgency !== "medium" && urgency !== "high") return null;
    if (typeof riskScore !== "number") return null;
    if (typeof reasoning !== "string") return null;

    return {
      service,
      description,
      amount_usd: amount,
      category,
      subcategory:
        typeof subcategoryRaw === "string" && subcategoryRaw.length > 0
          ? subcategoryRaw
          : null,
      urgency,
      risk_score: Math.max(0, Math.min(100, Math.round(riskScore))),
      reasoning,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[synth] one-call failed: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Concurrency runner — a simple semaphore lets us cap parallelism without
// pulling in p-limit. We don't need anything fancier than that.
// ---------------------------------------------------------------------------

async function runBatched<T>(
  total: number,
  concurrency: number,
  taskFor: (i: number) => Promise<T>,
  onProgress: (done: number) => void
): Promise<T[]> {
  const results: T[] = new Array(total);
  let next = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next;
      next += 1;
      if (i >= total) return;
      results[i] = await taskFor(i);
      completed += 1;
      onProgress(completed);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker())
  );
  return results;
}

async function main(): Promise<void> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || apiKey.length === 0) {
    console.error("Missing ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  const total = Number.parseInt(process.env["COUNT"] ?? "5000", 10);
  const concurrency = Number.parseInt(process.env["CONCURRENCY"] ?? "10", 10);
  const out = resolve(process.env["OUT"] ?? "./data/synthetic-classifications.jsonl");

  console.error(
    `[synth] generating ${total} examples (concurrency=${concurrency}) → ${out}`
  );
  console.error(
    `[synth] est. cost: ~$${((total * 300 * 0.8) / 1_000_000 + (total * 100 * 4) / 1_000_000).toFixed(2)}`
  );

  const client = new Anthropic({ apiKey });
  mkdirSync(dirname(out), { recursive: true });
  const stream = createWriteStream(out);

  let written = 0;
  let failed = 0;
  const start = Date.now();

  const onProgress = (done: number): void => {
    if (done % Math.max(1, Math.floor(total / 50)) === 0 || done === total) {
      const pct = ((done / total) * 100).toFixed(1);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      process.stderr.write(
        `\r[synth] ${done}/${total} (${pct}%) — written=${written} failed=${failed} — ${elapsed}s`
      );
    }
  };

  await runBatched(
    total,
    concurrency,
    async (i) => {
      const cat = CATEGORIES[i % CATEGORIES.length];
      const row = await synthesizeOne(client, cat);
      if (row === null) {
        failed += 1;
        return null;
      }
      stream.write(JSON.stringify(row) + "\n");
      written += 1;
      return null;
    },
    onProgress
  );

  await new Promise<void>((res) => stream.end(res));
  process.stderr.write("\n");
  console.error(
    `[synth] done. wrote=${written} failed=${failed} duration=${(
      (Date.now() - start) /
      1000
    ).toFixed(0)}s`
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[synth] fatal: ${msg}`);
  process.exit(1);
});
