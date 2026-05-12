// Uses the user's own Gamma API key — Spendex never uses a shared key.
// Each user generates a key at gamma.app/account/api and pastes it
// into their Spendex dashboard once during onboarding.

import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const GAMMA_API_BASE = "https://public-api.gamma.app/v0.2";

interface TriggerGammaGenerationParams {
  inputText: string;
  format?: "presentation" | "document" | "social";
  numCards?: number;
  gammaApiKey: string;
}

interface TriggerGammaGenerationResult {
  generationId: string;
}

interface PollGammaGenerationResult {
  gammaUrl: string;
  pdfUrl?: string;
  state: string;
}

interface GammaPollResponse {
  status: "pending" | "completed" | "failed";
  gammaUrl?: string;
  pdfUrl?: string;
}

export async function triggerGammaGeneration(
  params: TriggerGammaGenerationParams
): Promise<TriggerGammaGenerationResult> {
  const { inputText, format, numCards, gammaApiKey } = params;

  const url = `${GAMMA_API_BASE}/generations`;

  // Strip undefined fields so Gamma falls back to its own intelligent defaults
  // rather than receiving explicit nulls. Gamma's schema accepts `inputText`,
  // `format`, and `numCards` directly at the top level.
  const body: Record<string, unknown> = { inputText };
  if (format !== undefined) body["format"] = format;
  if (numCards !== undefined) body["numCards"] = numCards;

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(url, {
        method: "POST",
        headers: {
          "X-API-KEY": gammaApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      "network",
      "Could not reach gamma. Check your internet connection and try again.",
      "gamma"
    );
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw parseProviderError(response.status, errorBody, "gamma");
  }

  const data = (await response.json()) as { generationId: string };

  return { generationId: data.generationId };
}

export async function pollGammaGeneration(
  generationId: string,
  gammaApiKey: string,
  timeoutMs = 180_000,
  intervalMs = 5_000
): Promise<PollGammaGenerationResult> {
  const deadline = Date.now() + timeoutMs;
  const url = `${GAMMA_API_BASE}/generations/${generationId}`;

  while (true) {
    // Check timeout before each poll attempt
    if (Date.now() >= deadline) {
      throw new ProviderError(
        "unknown",
        "Gamma generation timed out after 180s. The generation may still complete — check the Gamma dashboard.",
        "gamma"
      );
    }

    let response: Response;
    try {
      response = await withRetry(() =>
        fetch(url, {
          headers: {
            "X-API-KEY": gammaApiKey,
          },
        })
      );
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        "network",
        "Could not reach gamma. Check your internet connection and try again.",
        "gamma"
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw parseProviderError(response.status, errorBody, "gamma");
    }

    const data = (await response.json()) as GammaPollResponse;

    if (data.status === "completed") {
      if (!data.gammaUrl) {
        throw new ProviderError(
          "unknown",
          "Gamma reported completion but did not return a gammaUrl. Check the Gamma dashboard.",
          "gamma"
        );
      }
      const result: PollGammaGenerationResult = {
        gammaUrl: data.gammaUrl,
        state: "completed",
      };
      if (data.pdfUrl !== undefined) result.pdfUrl = data.pdfUrl;
      return result;
    }

    if (data.status === "failed") {
      throw new ProviderError(
        "unknown",
        "Gamma generation failed. Check the Gamma dashboard for details.",
        "gamma"
      );
    }

    // Still pending — wait before polling again
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
