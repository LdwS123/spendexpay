// Uses the user's own Netlify personal access token — Spendex never uses a shared token.
// Each user generates a token on app.netlify.com/user/applications and pastes it
// into their Spendex dashboard once during onboarding.

import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const NETLIFY_API_BASE = "https://api.netlify.com/api/v1";

interface TriggerDeployParams {
  siteId: string;
  netlifyToken: string;
}

interface DeploymentResult {
  deployId: string;
  url: string;
}

export async function triggerNetlifyDeploy(params: TriggerDeployParams): Promise<DeploymentResult> {
  const { siteId, netlifyToken } = params;

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(`${NETLIFY_API_BASE}/sites/${siteId}/builds`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${netlifyToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("network", "Could not reach netlify. Check your internet connection and try again.", "netlify");
  }

  if (!response.ok) {
    const body = await response.text();
    throw parseProviderError(response.status, body, "netlify");
  }

  const data = (await response.json()) as { id: string; deploy_url: string | null | undefined };

  return {
    deployId: data.id,
    url: data.deploy_url ?? `https://app.netlify.com/sites/${siteId}/deploys/${data.id}`,
  };
}

export async function pollNetlifyDeploy(
  deployId: string,
  netlifyToken: string,
  timeoutMs = 120_000,
  intervalMs = 4_000
): Promise<{ url: string; state: string }> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    // Check timeout before each poll attempt
    if (Date.now() >= deadline) {
      throw new ProviderError(
        "unknown",
        "Netlify deployment timed out after 120s. Check the Netlify dashboard — the build may still complete.",
        "netlify"
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${NETLIFY_API_BASE}/deploys/${deployId}`,
        {
          headers: {
            Authorization: `Bearer ${netlifyToken}`,
          },
        }
      );
    } catch (err) {
      throw new ProviderError(
        "network",
        "Could not reach netlify. Check your internet connection and try again.",
        "netlify"
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw parseProviderError(response.status, body, "netlify");
    }

    const data = (await response.json()) as {
      id: string;
      state: string;
      deploy_ssl_url?: string | null;
      url?: string | null;
    };
    const state = data.state;

    if (state === "ready") {
      const url =
        data.deploy_ssl_url ?? data.url ?? `https://app.netlify.com/deploys/${deployId}`;
      return { url, state: "ready" };
    }

    if (state === "error" || state === "failed") {
      throw new ProviderError(
        "unknown",
        "Netlify build failed. Check the Netlify dashboard for build logs at app.netlify.com.",
        "netlify"
      );
    }

    // Not yet in a terminal state — wait before polling again
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
