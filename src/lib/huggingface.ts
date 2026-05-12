// Uses the user's own Hugging Face inference token — Spendex never uses a shared token.
// Each user generates a token at huggingface.co/settings/tokens and pastes it
// into their Spendex dashboard once during onboarding.

import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const HUGGINGFACE_API_BASE = "https://api-inference.huggingface.co/models";
const MAX_OUTPUT_CHARS = 4000;

interface RunHuggingFaceInferenceParams {
  modelId: string;
  inputs: unknown;
  parameters?: Record<string, unknown>;
  hfToken: string;
}

interface InferenceResult {
  output: string;
  modelId: string;
  durationMs: number;
}

interface HFGenerationItem {
  generated_text?: string;
}

function coalesceOutput(raw: unknown): string {
  // HF returns one of:
  //   - Array of generations: [{generated_text: "..."}]
  //   - Single object: {generated_text: "..."} or arbitrary shape
  //   - Embedding/classifier arrays (numbers, label objects, etc.)
  // We stringify whatever it gives us into a single human-readable string.
  if (Array.isArray(raw)) {
    if (raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null && "generated_text" in (raw[0] as object)) {
      const texts = (raw as HFGenerationItem[])
        .map((item) => item.generated_text ?? "")
        .filter((t) => t.length > 0);
      if (texts.length > 0) return texts.join("\n");
    }
    return JSON.stringify(raw);
  }
  if (raw !== null && typeof raw === "object") {
    const obj = raw as HFGenerationItem & Record<string, unknown>;
    if (typeof obj.generated_text === "string") return obj.generated_text;
    return JSON.stringify(raw);
  }
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw);
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + " [truncated]";
}

export async function runHuggingFaceInference(
  params: RunHuggingFaceInferenceParams
): Promise<InferenceResult> {
  const { modelId, inputs, parameters, hfToken } = params;

  const url = `${HUGGINGFACE_API_BASE}/${modelId}`;
  const body: Record<string, unknown> = { inputs };
  if (parameters !== undefined) body["parameters"] = parameters;

  const startedAt = Date.now();

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hfToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      "network",
      "Could not reach huggingface. Check your internet connection and try again.",
      "huggingface"
    );
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw parseProviderError(response.status, errorBody, "huggingface");
  }

  const data = (await response.json()) as unknown;
  const combined = coalesceOutput(data);
  const output = truncateOutput(combined);
  const durationMs = Date.now() - startedAt;

  return { output, modelId, durationMs };
}
