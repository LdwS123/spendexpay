// Uses the user's own Fly.io API token — Spendex never uses a shared token.
// Each user generates a token on fly.io/user/personal_access_tokens and pastes it
// into their Spendex dashboard once during onboarding.

import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const FLYIO_GRAPHQL_ENDPOINT = "https://api.fly.io/graphql";

interface TriggerFlyDeployParams {
  appName: string;
  flyToken: string;
}

interface DeploymentResult {
  releaseId: string;
  url: string;
}

export async function triggerFlyDeploy(params: TriggerFlyDeployParams): Promise<DeploymentResult> {
  const { appName, flyToken } = params;

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(FLYIO_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${flyToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "mutation DeployImage($input: DeployImageInput!) { deployImage(input: $input) { release { id version status } app { hostname } } }",
          variables: {
            input: {
              appId: appName,
              strategy: "ROLLING",
            },
          },
        }),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("network", "Could not reach flyio. Check your internet connection and try again.", "flyio");
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw parseProviderError(response.status, errorBody, "flyio");
  }

  const body = (await response.json()) as {
    data?: {
      deployImage: {
        release: { id: string; version: number; status: string };
        app: { hostname: string };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (body.errors && body.errors.length > 0) {
    throw new Error(`Fly.io API error: ${body.errors[0].message}`);
  }

  const { release, app } = body.data!.deployImage;

  return {
    releaseId: release.id,
    url: `https://${app.hostname}`,
  };
}

export async function pollFlyDeployment(
  releaseId: string,
  appName: string,
  flyToken: string,
  timeoutMs = 120_000,
  intervalMs = 5_000
): Promise<{ url: string; state: string }> {
  const deadline = Date.now() + timeoutMs;
  const version = parseInt(releaseId, 10);

  while (true) {
    if (Date.now() >= deadline) {
      throw new ProviderError(
        "unknown",
        "Fly.io deployment timed out after 120s.",
        "flyio"
      );
    }

    let response: Response;
    try {
      response = await fetch(FLYIO_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${flyToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "query ReleaseStatus($appName: String!, $version: Int!) { app(name: $appName) { release(version: $version) { id status } } }",
          variables: { appName, version },
        }),
      });
    } catch (err) {
      throw new ProviderError(
        "network",
        "Could not reach flyio. Check your internet connection and try again.",
        "flyio"
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw parseProviderError(response.status, errorBody, "flyio");
    }

    const body = (await response.json()) as {
      data?: { app: { release: { id: string; status: string } } };
      errors?: Array<{ message: string }>;
    };

    if (body.errors && body.errors.length > 0) {
      throw new ProviderError("unknown", body.errors[0].message, "flyio");
    }

    const { status } = body.data!.app.release;

    if (status === "complete") {
      return {
        url: `https://${appName}.fly.dev`,
        state: "complete",
      };
    }

    if (status === "failed") {
      throw new ProviderError(
        "unknown",
        "Fly.io deployment failed. Check `flyctl logs` for details.",
        "flyio"
      );
    }

    // Not yet in a terminal state — wait before polling again
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
