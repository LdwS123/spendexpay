/**
 * Ollama backend for the purchase-intent classifier.
 *
 * Implements the `ClassifierBackend` interface using Ollama's HTTP API at
 * `OLLAMA_BASE_URL` (default http://localhost:11434). The model id comes
 * from `OLLAMA_MODEL` (default "llama3.2:3b" — replace with a fine-tuned
 * tag like "spendex-classifier:v1" after running scripts/finetune/).
 *
 * Why this exists:
 *
 *   - Privacy: classifications stay on the user's machine; no merchant
 *     name or charge amount ever leaves the network.
 *   - Cost: after the model is fine-tuned and deployed locally, marginal
 *     cost per classification is electricity, not $0.00X per call.
 *   - Latency: a 3B model on Apple Silicon answers in ~150–300ms vs.
 *     ~600–1200ms for a Haiku round-trip.
 *
 * Contract (same as AnthropicHaikuBackend):
 *
 *   - Never throws — returns null on any failure so the orchestrator can
 *     fall back to the static "unknown" classification.
 *   - 5s AbortController timeout shared via `CLASSIFY_TIMEOUT_MS`.
 *   - Validates and clamps the raw response via `normalizeClassification`.
 */

import {
  type ClassifierBackend,
  type ClassifyParams,
  type IntentClassification,
  CLASSIFY_TIMEOUT_MS,
  SYSTEM_PROMPT,
  normalizeClassification,
} from "./intent-classifier.js";

// ---------------------------------------------------------------------------
// Config — read fresh on every classify() call so tests and operators can
// flip env vars without a restart.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.2:3b";

function getBaseUrl(): string {
  const v = process.env["OLLAMA_BASE_URL"];
  if (!v || v.length === 0) return DEFAULT_BASE_URL;
  return v.replace(/\/+$/, "");
}

function getModel(): string {
  const v = process.env["OLLAMA_MODEL"];
  if (!v || v.length === 0) return DEFAULT_MODEL;
  return v;
}

// ---------------------------------------------------------------------------
// Prompt template — instructs the model to emit STRICT JSON matching the
// IntentClassification shape. Ollama's `format: "json"` constraint ensures
// the response is JSON-parseable; the field-name discipline below is on us.
// ---------------------------------------------------------------------------

const JSON_INSTRUCTION =
  "Respond with a SINGLE JSON object and nothing else. The object MUST have " +
  "exactly these fields:\n" +
  '  - "category": one of "dev_tools", "shopping", "subscription", "food", ' +
  '"travel", "gambling", "crypto", "gift_cards", "cash_advance", "unknown".\n' +
  '  - "subcategory": a short string (e.g. "cloud_compute", "electronics") ' +
  "or null.\n" +
  '  - "urgency": one of "low", "medium", "high".\n' +
  '  - "risk_score": integer 0–100.\n' +
  '  - "reasoning": 1–2 sentence string explaining the score.\n' +
  "Do not add commentary before or after the JSON. Do not wrap it in " +
  "markdown fences. Do not include any other fields.";

function buildUserMessage(params: ClassifyParams): string {
  return (
    `service: ${params.service}\n` +
    `amount_usd: ${params.amount_usd}\n` +
    `description: ${params.description}\n\n` +
    JSON_INSTRUCTION
  );
}

// ---------------------------------------------------------------------------
// Ollama /api/chat response shape (subset we care about)
// ---------------------------------------------------------------------------

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  done?: boolean;
  // Other fields (created_at, total_duration, eval_count, …) are ignored.
}

function isOllamaChatResponse(value: unknown): value is OllamaChatResponse {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export class OllamaBackend implements ClassifierBackend {
  public get name(): string {
    return `ollama:${getModel()}`;
  }

  async classify(params: ClassifyParams): Promise<IntentClassification | null> {
    const baseUrl = getBaseUrl();
    const model = getModel();
    const endpoint = `${baseUrl}/api/chat`;

    const body = JSON.stringify({
      model,
      // `format: "json"` is Ollama's structured-output constraint: the
      // server resamples until the response parses as JSON. Combined with
      // the prompt instructions above, we reliably get the right shape.
      format: "json",
      stream: false,
      options: {
        // Low temperature for classification: we want consistent labels,
        // not creative writing. 0.1 keeps a touch of variance without
        // veering off-spec.
        temperature: 0.1,
        // Cap output length so a runaway sampler can't stall the 5s
        // budget by writing a novel.
        num_predict: 400,
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(params) },
      ],
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[intent-classifier-ollama] fetch failed for ${endpoint}: ${message}`
      );
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      console.error(
        `[intent-classifier-ollama] HTTP ${response.status} from ${endpoint}`
      );
      return null;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[intent-classifier-ollama] body was not JSON: ${message}`
      );
      return null;
    }

    if (!isOllamaChatResponse(payload)) {
      console.error(
        `[intent-classifier-ollama] response did not match expected shape`
      );
      return null;
    }

    const content = payload.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      console.error(
        `[intent-classifier-ollama] response had no message.content`
      );
      return null;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (err) {
      // Ollama's format:"json" should prevent this, but guard anyway —
      // older Ollama builds or non-conforming models can slip text out.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[intent-classifier-ollama] message.content was not valid JSON: ${message}. ` +
        `content=${content.slice(0, 200)}`
      );
      return null;
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      console.error(
        `[intent-classifier-ollama] parsed JSON was not an object`
      );
      return null;
    }

    const parsed = normalizeClassification(
      raw as Record<string, unknown>,
      `ollama:${model}`
    );
    if (parsed === null) {
      console.error(
        `[intent-classifier-ollama] response did not validate. ` +
        `keys=${Object.keys(raw as Record<string, unknown>).join(",")}`
      );
      return null;
    }
    return parsed;
  }
}
