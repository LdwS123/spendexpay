/**
 * Purchase-intent classifier — turns a free-text "what is the agent about to
 * buy?" string into a structured (category, urgency, risk_score) record that
 * the smart-rules engine can evaluate against the user's contextual rules.
 *
 * Powered by a pluggable backend (Anthropic Haiku 4.5 by default, optionally
 * a local Ollama model). The backend is selected via the `CLASSIFIER_BACKEND`
 * env var. The orchestration layer (DEV_MODE bypass, cache lookup, cache
 * write, fallback on backend failure) stays identical regardless of the
 * backend chosen.
 *
 * Three guardrails:
 *
 *   1. DEV_MODE bypass — returns a deterministic fake classification so
 *      tests and local runs never make a network call.
 *   2. Missing-key / unreachable-backend fallback — if the chosen backend
 *      cannot serve (missing key, network error, timeout, malformed
 *      response) we return a neutral "unknown" classification rather than
 *      blocking the charge. Smart rules are opt-in; the static numeric
 *      caps still protect the user.
 *   3. Timeout — 5 seconds. The backend's `classify()` is responsible for
 *      its own AbortController; the orchestrator never holds up an MCP
 *      tool call.
 *
 * Persistence: every successful classification is cached in
 * `intent_classifications` for 7 days, keyed by SHA-256 of the
 * (service + description + amount_bucket) tuple. The amount is bucketed so
 * "$19.99" and "$20.00" hit the same cache row.
 */

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { DEV_MODE } from "../config.js";
import { getSupabase } from "./db.js";
// The Ollama backend lives in a sibling file. Importing it statically is
// safe because Ollama is a class — instantiation is deferred until the
// factory chooses it. The cyclic dependency on the types exported above
// resolves naturally for type-only imports in the dependent module.
import { OllamaBackend } from "./intent-classifier-ollama.js";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type IntentUrgency = "low" | "medium" | "high";

export type IntentCategory =
  | "dev_tools"
  | "shopping"
  | "subscription"
  | "food"
  | "travel"
  | "gambling"
  | "crypto"
  | "gift_cards"
  | "cash_advance"
  | "unknown";

export interface IntentClassification {
  category: IntentCategory | string;
  subcategory: string | null;
  urgency: IntentUrgency;
  risk_score: number;
  reasoning: string;
  /** Whether the result came from the cache, the LLM, or a static fallback. */
  source: "cache" | "llm" | "fallback" | "dev_mode";
  /** Model identifier — useful for downstream eval / debugging. */
  model: string;
}

export interface ClassifyParams {
  service: string;
  description: string;
  amount_usd: number;
}

/**
 * A pluggable classifier backend. The orchestrator (`classifyIntent` below)
 * owns caching, DEV_MODE bypass, and fallback. Backends only do the actual
 * inference call — keep them small.
 */
export interface ClassifierBackend {
  /** Human-readable backend name, surfaced in logs and the `model` field. */
  name: string;
  /**
   * Run inference and return a parsed classification, or null on any
   * failure (timeout, malformed response, missing config). Must never
   * throw — the orchestrator turns null into the static fallback.
   */
  classify(params: ClassifyParams): Promise<IntentClassification | null>;
}

// ---------------------------------------------------------------------------
// Constants — shared by all backends
// ---------------------------------------------------------------------------

export const MODEL_ID = "claude-haiku-4-5-20251001";
export const CLASSIFY_TIMEOUT_MS = 5_000;

export const SYSTEM_PROMPT =
  "You are a purchase-intent classifier for an AI agent wallet (Spendex). " +
  "Given a merchant + description + amount, output a structured classification " +
  "the rules engine uses to decide whether to authorize the charge.\n\n" +
  "Categories (pick the closest match):\n" +
  "  dev_tools     — cloud compute, APIs, SaaS used to ship software\n" +
  "                  (Vercel, Modal, OpenAI, Anthropic, AWS, GitHub, …)\n" +
  "  shopping      — physical goods (Amazon, Best Buy, eBay)\n" +
  "  subscription  — recurring consumer services (Netflix, Spotify, NYT)\n" +
  "  food          — food and groceries (DoorDash, Instacart)\n" +
  "  travel        — flights, hotels, ride-share (Uber, Airbnb)\n" +
  "  gambling      — casinos, sportsbooks, lottery\n" +
  "  crypto        — exchanges, on-ramps, NFT marketplaces\n" +
  "  gift_cards    — prepaid gift cards (high fraud signal)\n" +
  "  cash_advance  — wires, money transfers, cash-equivalent\n" +
  "  unknown       — none of the above clearly fits\n\n" +
  "Urgency reflects whether the charge is time-sensitive (high = needs to land " +
  "now to unblock the agent's work; low = nice to have, can wait).\n\n" +
  "Risk score is 0–100 where 0 is trivially safe (publisher SaaS subscription) " +
  "and 100 is clearly fraudulent (gift cards at 3am for $5000). " +
  "Use intermediate values; do not bucket.\n\n" +
  "Reasoning must be 1–2 short sentences explaining the score.\n\n" +
  "Examples:\n" +
  '  service="vercel" amount=20 desc="Upgrade my-app to Pro"\n' +
  '  → {category:"dev_tools", subcategory:"cloud_compute", urgency:"medium", risk_score:5}\n' +
  '  service="draftkings" amount=200 desc="weekly fantasy entry"\n' +
  '  → {category:"gambling", subcategory:"sports_betting", urgency:"low", risk_score:85}\n' +
  '  service="amazon" amount=1499 desc="MacBook Pro 14"\n' +
  '  → {category:"shopping", subcategory:"electronics", urgency:"medium", risk_score:25}';

// Tool-use forced output — Claude can only respond by invoking this tool, so
// we get strict JSON without a brittle "respond only in JSON" prompt.
const CLASSIFICATION_TOOL = {
  name: "submit_classification",
  description:
    "Submit the structured classification for the purchase intent. " +
    "Always call this tool exactly once. Do not respond in plain text.",
  input_schema: {
    type: "object" as const,
    properties: {
      category: {
        type: "string",
        description:
          "One of: dev_tools, shopping, subscription, food, travel, " +
          "gambling, crypto, gift_cards, cash_advance, unknown.",
      },
      subcategory: {
        type: ["string", "null"],
        description: "Optional finer-grained label, e.g. 'cloud_compute'.",
      },
      urgency: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
      risk_score: {
        type: "integer",
        minimum: 0,
        maximum: 100,
      },
      reasoning: {
        type: "string",
        description: "1–2 sentence justification.",
      },
    },
    required: ["category", "urgency", "risk_score", "reasoning"],
  },
};

// ---------------------------------------------------------------------------
// Hash + bucketing
// ---------------------------------------------------------------------------

const AMOUNT_BUCKETS: ReadonlyArray<number> = [1, 10, 100, 1000, 10000];

/**
 * Bucket an amount into the smallest preset that is >= the value. Means
 * "$19.99" and "$20.00" share a cache key but "$2000" doesn't collapse with
 * "$20". Falls back to "above_max" when the spec's largest bucket is
 * exceeded so the cache still de-duplicates extreme values.
 */
function bucketAmount(amount: number): string {
  for (const bucket of AMOUNT_BUCKETS) {
    if (amount <= bucket) return String(bucket);
  }
  return "above_max";
}

/**
 * Build the SHA-256 hash that keys the cache. Normalised case + whitespace so
 * "Subscribe Vercel Pro " and "subscribe vercel pro" share a row.
 */
export function buildDescriptionHash(params: ClassifyParams): string {
  const canonical =
    params.service.trim().toLowerCase() +
    "|" +
    params.description.trim().toLowerCase().replace(/\s+/g, " ") +
    "|" +
    bucketAmount(params.amount_usd);
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Shared validation — used by every backend that wants the same clamping
// and shape rules. Exported so OllamaBackend can reuse it.
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a raw classification object from any backend.
 * Returns null when the object doesn't have the required fields in the
 * expected shape. `risk_score` is clamped to [0, 100]; any unknown or
 * empty category falls back to "unknown".
 *
 * Exported so backend implementations can reuse the same rules.
 */
export function normalizeClassification(
  raw: Record<string, unknown>,
  modelLabel: string
): IntentClassification | null {
  const category = raw["category"];
  const urgency = raw["urgency"];
  const riskScore = raw["risk_score"];
  const reasoning = raw["reasoning"];
  const subcategoryRaw = raw["subcategory"];

  if (typeof category !== "string" || category.length === 0) return null;
  if (urgency !== "low" && urgency !== "medium" && urgency !== "high") return null;
  if (typeof riskScore !== "number" || !Number.isFinite(riskScore)) return null;
  if (typeof reasoning !== "string") return null;

  const clampedRisk = Math.max(0, Math.min(100, Math.round(riskScore)));
  const subcategory =
    typeof subcategoryRaw === "string" && subcategoryRaw.length > 0
      ? subcategoryRaw
      : null;

  // Empty string category — treat as unknown so the rules engine has a
  // valid label to evaluate against.
  const normalizedCategory = category.trim().length === 0 ? "unknown" : category;

  return {
    category: normalizedCategory,
    subcategory,
    urgency,
    risk_score: clampedRisk,
    reasoning,
    source: "llm",
    model: modelLabel,
  };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

interface RawCachedRow {
  category: string | null;
  subcategory: string | null;
  urgency: IntentUrgency | null;
  risk_score: number | null;
  reasoning: string | null;
  model: string | null;
}

/**
 * Look up the freshest non-expired classification for this hash. Filtering on
 * `ttl_expires_at > now()` in SQL skips stale rows entirely so we never have
 * to run an eviction job. Returns null when no row matches OR on any DB
 * error — callers treat both the same (re-classify or fall back).
 */
export async function getCachedClassification(
  hash: string
): Promise<IntentClassification | null> {
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await getSupabase()
      .from("intent_classifications")
      .select("category, subcategory, urgency, risk_score, reasoning, model")
      .eq("description_hash", hash)
      .gt("ttl_expires_at", nowIso)
      .order("ttl_expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code !== "PGRST116") {
        console.error(
          `[intent-classifier] getCachedClassification: unexpected error ` +
          `(code: ${error.code}): ${error.message}. hash=${hash}`
        );
      }
      return null;
    }
    if (!data) return null;

    const row = data as RawCachedRow;
    if (
      row.category === null ||
      row.urgency === null ||
      row.risk_score === null
    ) {
      return null;
    }

    return {
      category: row.category,
      subcategory: row.subcategory,
      urgency: row.urgency,
      risk_score: row.risk_score,
      reasoning: row.reasoning ?? "",
      source: "cache",
      model: row.model ?? MODEL_ID,
    };
  } catch (err) {
    console.error(
      `[intent-classifier] getCachedClassification: caught error: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

interface CacheClassificationParams {
  hash: string;
  service: string;
  amount_usd: number;
  classification: IntentClassification;
}

/**
 * Persist a fresh classification for 7 days. Best-effort: a write failure is
 * logged but does NOT throw — the caller has the in-memory result and will
 * just miss the cache on the next call for the same hash.
 */
export async function cacheClassification(
  params: CacheClassificationParams
): Promise<void> {
  try {
    const { error } = await getSupabase().from("intent_classifications").insert({
      description_hash: params.hash,
      service: params.service,
      amount_usd: params.amount_usd,
      category: params.classification.category,
      subcategory: params.classification.subcategory,
      urgency: params.classification.urgency,
      risk_score: params.classification.risk_score,
      reasoning: params.classification.reasoning,
      model: params.classification.model,
    });

    if (error) {
      console.error(
        `[intent-classifier] cacheClassification: insert failed for hash=${params.hash}: ` +
        `${error.message} (code: ${error.code}).`
      );
    }
  } catch (err) {
    console.error(
      `[intent-classifier] cacheClassification: caught error: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Anthropic Haiku backend
// ---------------------------------------------------------------------------

let _anthropic: Anthropic | null = null;
function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || apiKey.length === 0) return null;
  if (_anthropic === null) {
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

/**
 * Reset the cached Anthropic client. Test-only — exported for unit tests that
 * flip the env var between cases.
 */
export function resetAnthropicClientForTests(): void {
  _anthropic = null;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

type AnthropicContentBlock = AnthropicToolUseBlock | AnthropicTextBlock;

function isToolUseBlock(block: AnthropicContentBlock): block is AnthropicToolUseBlock {
  return block.type === "tool_use";
}

/**
 * Anthropic Haiku 4.5 backend. Uses tool-use forced output for strict JSON.
 * Returns null on any failure mode (missing key, network error, malformed
 * response, no tool_use block).
 */
export class AnthropicHaikuBackend implements ClassifierBackend {
  public readonly name = "anthropic-haiku-4.5";

  async classify(params: ClassifyParams): Promise<IntentClassification | null> {
    const client = getAnthropicClient();
    if (client === null) {
      // No API key configured. Return null so the orchestrator falls back.
      return null;
    }

    const userMessage =
      `service: ${params.service}\n` +
      `amount_usd: ${params.amount_usd}\n` +
      `description: ${params.description}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);

      let response;
      try {
        response = await client.messages.create(
          {
            model: MODEL_ID,
            max_tokens: 400,
            system: SYSTEM_PROMPT,
            tools: [CLASSIFICATION_TOOL],
            tool_choice: { type: "tool", name: CLASSIFICATION_TOOL.name },
            messages: [{ role: "user", content: userMessage }],
          },
          { signal: controller.signal }
        );
      } finally {
        clearTimeout(timer);
      }

      const content = response.content as AnthropicContentBlock[];
      for (const block of content) {
        if (!isToolUseBlock(block)) continue;
        if (block.name !== CLASSIFICATION_TOOL.name) continue;
        const parsed = normalizeClassification(block.input, MODEL_ID);
        if (parsed) return parsed;
      }
      console.error(
        `[intent-classifier] AnthropicHaikuBackend: response had no valid tool_use block ` +
        `for service=${params.service}`
      );
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[intent-classifier] AnthropicHaikuBackend: error during classify call: ${message}`
      );
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Backend factory
// ---------------------------------------------------------------------------

let _backend: ClassifierBackend | null = null;

/**
 * Resolve the active classifier backend from the `CLASSIFIER_BACKEND` env
 * var. Defaults to "anthropic" (preserves legacy behaviour). The backend is
 * cached after first lookup — tests can reset via `resetBackendForTests()`.
 */
export function getClassifierBackend(): ClassifierBackend {
  if (_backend !== null) return _backend;

  const choice = (process.env["CLASSIFIER_BACKEND"] ?? "anthropic").toLowerCase();
  if (choice === "ollama") {
    _backend = new OllamaBackend();
  } else {
    _backend = new AnthropicHaikuBackend();
  }
  return _backend;
}

/**
 * Reset the cached backend instance. Test-only — exported for unit tests
 * that flip `CLASSIFIER_BACKEND` between cases.
 */
export function resetBackendForTests(): void {
  _backend = null;
  _anthropic = null;
}

// ---------------------------------------------------------------------------
// Fallback + dev mode
// ---------------------------------------------------------------------------

const FALLBACK_CLASSIFICATION: Omit<IntentClassification, "source"> = {
  category: "unknown",
  subcategory: null,
  urgency: "medium",
  risk_score: 50,
  reasoning: "classification unavailable; using neutral fallback",
  model: MODEL_ID,
};

function makeFallback(reasoning: string): IntentClassification {
  return {
    ...FALLBACK_CLASSIFICATION,
    reasoning,
    source: "fallback",
  };
}

function makeDevClassification(params: ClassifyParams): IntentClassification {
  // Deterministic-ish fake — a few well-known services land on plausible
  // categories so tests asserting on category="dev_tools" work without an
  // actual LLM call.
  const lower = params.service.toLowerCase();
  const known: Record<string, { category: IntentCategory; subcategory: string }> = {
    vercel: { category: "dev_tools", subcategory: "cloud_compute" },
    modal: { category: "dev_tools", subcategory: "cloud_compute" },
    openai: { category: "dev_tools", subcategory: "api" },
    anthropic: { category: "dev_tools", subcategory: "api" },
    github: { category: "dev_tools", subcategory: "version_control" },
    cloudflare: { category: "dev_tools", subcategory: "cdn" },
    amazon: { category: "shopping", subcategory: "marketplace" },
    netflix: { category: "subscription", subcategory: "streaming" },
    spotify: { category: "subscription", subcategory: "streaming" },
    uber: { category: "travel", subcategory: "ride_share" },
    doordash: { category: "food", subcategory: "delivery" },
    draftkings: { category: "gambling", subcategory: "sports_betting" },
    coinbase: { category: "crypto", subcategory: "exchange" },
  };
  const match = known[lower];
  const category: IntentCategory = match?.category ?? "unknown";
  const subcategory = match?.subcategory ?? null;
  const riskByCategory: Record<IntentCategory, number> = {
    dev_tools: 5,
    shopping: 25,
    subscription: 10,
    food: 15,
    travel: 20,
    gambling: 85,
    crypto: 70,
    gift_cards: 80,
    cash_advance: 90,
    unknown: 50,
  };
  return {
    category,
    subcategory,
    urgency: "medium",
    risk_score: riskByCategory[category],
    reasoning: `[DEV MODE] fake classification for ${params.service} ($${params.amount_usd.toFixed(2)})`,
    source: "dev_mode",
    model: "dev-mode",
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classify a purchase intent. Order of fallbacks:
 *
 *   1. DEV_MODE → deterministic fake classification (no network).
 *   2. Cache hit (7-day TTL) → return immediately.
 *   3. Active backend's classify() (5s timeout, structured output).
 *   4. Static fallback ("unknown" / risk_score=50) on any failure.
 *
 * Never throws — every failure mode is funnelled into a valid classification
 * so `pay_for_service` can rely on always getting a structured answer.
 */
export async function classifyIntent(
  params: ClassifyParams
): Promise<IntentClassification> {
  if (DEV_MODE) {
    return makeDevClassification(params);
  }

  const hash = buildDescriptionHash(params);
  const cached = await getCachedClassification(hash);
  if (cached) return cached;

  const backend = getClassifierBackend();
  const classified = await backend.classify(params);
  if (classified === null) {
    return makeFallback(`${backend.name}: classification unavailable; using neutral fallback`);
  }

  await cacheClassification({
    hash,
    service: params.service,
    amount_usd: params.amount_usd,
    classification: classified,
  });

  return classified;
}
