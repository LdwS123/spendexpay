// Uses the user's own Railway API token — Spendex never uses a shared token.
// Each user generates a token on railway.com/account/tokens and pastes it
// into their Spendex dashboard once during onboarding.

import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";

interface TriggerDeployParams {
  serviceId: string;
  environmentId?: string;
  railwayToken: string;
}

interface DeploymentResult {
  deploymentId: string;
  url: string;
}

export async function triggerRailwayDeploy(params: TriggerDeployParams): Promise<DeploymentResult> {
  const { serviceId, environmentId, railwayToken } = params;

  const variables: Record<string, string> = { serviceId };
  if (environmentId) variables["environmentId"] = environmentId;

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(RAILWAY_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${railwayToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }",
          variables,
        }),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("network", "Could not reach railway. Check your internet connection and try again.", "railway");
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw parseProviderError(response.status, errorBody, "railway");
  }

  const body = (await response.json()) as { data?: { serviceInstanceRedeploy: boolean }; errors?: Array<{ message: string }> };

  if (body.errors && body.errors.length > 0) {
    throw new Error(`Railway API error: ${body.errors[0].message}`);
  }

  return {
    // Railway's redeploy mutation returns a boolean, not a deployment ID.
    // We synthesise a locally unique ID so the audit log has a stable reference.
    deploymentId: `${serviceId}-${Date.now()}`,
    url: "https://railway.app/dashboard",
  };
}

export async function pollRailwayDeployment(
  deploymentId: string,
  railwayToken: string,
  timeoutMs = 120_000,
  intervalMs = 5_000
): Promise<{ url: string; state: string }> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (Date.now() >= deadline) {
      throw new ProviderError(
        "unknown",
        "Railway deployment timed out after 120s.",
        "railway"
      );
    }

    let response: Response;
    try {
      response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${railwayToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "query DeploymentStatus($id: String!) { deployment(id: $id) { id status staticUrl } }",
          variables: { id: deploymentId },
        }),
      });
    } catch (err) {
      throw new ProviderError(
        "network",
        "Could not reach railway. Check your internet connection and try again.",
        "railway"
      );
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw parseProviderError(response.status, errorBody, "railway");
    }

    const body = (await response.json()) as {
      data?: { deployment: { id: string; status: string; staticUrl?: string } };
      errors?: Array<{ message: string }>;
    };

    if (body.errors && body.errors.length > 0) {
      throw new ProviderError("unknown", body.errors[0].message, "railway");
    }

    const { status, staticUrl } = body.data!.deployment;

    if (status === "SUCCESS") {
      return {
        url: staticUrl ?? "https://railway.app/dashboard",
        state: "SUCCESS",
      };
    }

    if (status === "FAILED" || status === "CRASHED" || status === "REMOVED") {
      throw new ProviderError(
        "unknown",
        `Railway deployment failed (status: ${status}). Check your Railway dashboard.`,
        "railway"
      );
    }

    // Not yet in a terminal state — wait before polling again
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
