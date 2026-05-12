import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

interface TriggerReplicatePredictionParams {
  modelVersion: string;
  inputJson: string;
  replicateToken: string;
}

interface PredictionResult {
  predictionId: string;
  outputSummary: string;
  url: string;
}

export async function triggerReplicatePrediction(
  params: TriggerReplicatePredictionParams
): Promise<PredictionResult> {
  const { modelVersion, inputJson, replicateToken } = params;

  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(inputJson);
  } catch {
    throw new Error("Invalid input_json: must be a valid JSON object string");
  }

  let createResponse: Response;
  try {
    createResponse = await withRetry(() =>
      fetch(`${REPLICATE_API_BASE}/predictions`, {
        method: "POST",
        headers: {
          Authorization: `Token ${replicateToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: modelVersion, input: parsedInput }),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("network", "Could not reach replicate. Check your internet connection and try again.", "replicate");
  }

  if (!createResponse.ok) {
    const errorBody = await createResponse.text();
    throw parseProviderError(createResponse.status, errorBody, "replicate");
  }

  const created = (await createResponse.json()) as {
    id: string;
    status: string;
    urls: { get: string };
  };

  const id = created.id;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    let pollResponse: Response;
    try {
      pollResponse = await fetch(`${REPLICATE_API_BASE}/predictions/${id}`, {
        headers: { Authorization: `Token ${replicateToken}` },
      });
    } catch (err) {
      throw new ProviderError("network", "Could not reach replicate. Check your internet connection and try again.", "replicate");
    }

    if (!pollResponse.ok) {
      const errorBody = await pollResponse.text();
      throw parseProviderError(pollResponse.status, errorBody, "replicate");
    }

    const data = (await pollResponse.json()) as {
      id: string;
      status: string;
      output: unknown;
      error: string | null;
    };

    if (data.status === "succeeded") {
      const outputSummary = JSON.stringify(data.output).slice(0, 500);
      const url = `https://replicate.com/p/${id}`;
      return { predictionId: id, outputSummary, url };
    }

    if (data.status === "failed") {
      throw new ProviderError(
        "unknown",
        "Replicate prediction failed: " + (data.error ?? "unknown error") + ". Check https://replicate.com/predictions/" + data.id,
        "replicate"
      );
    }

    if (data.status === "canceled") {
      throw new ProviderError(
        "unknown",
        "Replicate prediction was canceled. Check https://replicate.com/predictions/" + data.id,
        "replicate"
      );
    }
  }

  throw new ProviderError(
    "unknown",
    "Replicate prediction timed out after 60s. It may still complete — check https://replicate.com/predictions/" + id,
    "replicate"
  );
}
