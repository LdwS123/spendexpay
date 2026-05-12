// Uses the user's own Vercel API token — Spendex never uses a shared token.
// Each user generates a token on vercel.com/account/tokens and pastes it
// into their Spendex dashboard once during onboarding.

import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const VERCEL_API_BASE = "https://api.vercel.com";

interface TriggerDeployParams {
  projectName: string;
  teamSlug?: string;
  vercelToken: string;
}

interface DeploymentResult {
  url: string;
  deploymentId: string;
}

export async function triggerVercelDeploy(params: TriggerDeployParams): Promise<DeploymentResult> {
  const { projectName, teamSlug, vercelToken } = params;

  const queryParams = teamSlug ? `?teamId=${encodeURIComponent(teamSlug)}` : "";
  const url = `${VERCEL_API_BASE}/v13/deployments${queryParams}`;

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${vercelToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: projectName,
          // Redeploy the latest commit rather than uploading files.
          // Assumes the user's repo is already connected to Vercel.
          target: "production",
        }),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("network", "Could not reach vercel. Check your internet connection and try again.", "vercel");
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw parseProviderError(response.status, errorBody, "vercel");
  }

  const data = (await response.json()) as { id: string; url: string };

  return {
    deploymentId: data.id,
    url: `https://${data.url}`,
  };
}

export async function pollVercelDeployment(
  deploymentId: string,
  vercelToken: string,
  timeoutMs = 120_000,
  intervalMs = 4_000
): Promise<{ url: string; state: string }> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    // Check timeout before each poll attempt
    if (Date.now() >= deadline) {
      throw new ProviderError(
        "unknown",
        "Vercel deployment timed out after 120s. The build may still complete — check the Vercel dashboard.",
        "vercel"
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${VERCEL_API_BASE}/v13/deployments/${deploymentId}`,
        {
          headers: {
            Authorization: `Bearer ${vercelToken}`,
          },
        }
      );
    } catch (err) {
      throw new ProviderError(
        "network",
        "Could not reach vercel. Check your internet connection and try again.",
        "vercel"
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw parseProviderError(response.status, errorBody, "vercel");
    }

    const data = (await response.json()) as { id: string; url: string; readyState: string };
    const state = data.readyState;

    if (state === "READY") {
      return { url: `https://${data.url}`, state: "READY" };
    }

    if (state === "ERROR" || state === "CANCELED") {
      throw new ProviderError(
        "unknown",
        `Vercel build failed (state: ${state}). Check the Vercel dashboard for build logs.`,
        "vercel"
      );
    }

    // Not yet in a terminal state — wait before polling again
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
