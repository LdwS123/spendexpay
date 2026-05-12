import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const RENDER_API_BASE = "https://api.render.com/v1";

interface TriggerRenderDeployParams {
  serviceId: string;
  renderToken: string;
}

interface RenderDeployResult {
  deployId: string;
  url: string;
}

export async function triggerRenderDeploy(params: TriggerRenderDeployParams): Promise<RenderDeployResult> {
  const { serviceId, renderToken } = params;

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(`${RENDER_API_BASE}/services/${serviceId}/deploys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${renderToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("network", "Could not reach render. Check your internet connection and try again.", "render");
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw parseProviderError(response.status, errorBody, "render");
  }

  const data = (await response.json()) as { deploy?: { id: string } };

  if (!data.deploy) {
    throw new Error("Render API returned unexpected response");
  }

  return {
    deployId: data.deploy.id,
    url: `https://dashboard.render.com/web/${serviceId}`,
  };
}

export async function pollRenderDeploy(
  serviceId: string,
  deployId: string,
  renderToken: string,
  timeoutMs = 120_000,
  intervalMs = 5_000
): Promise<{ url: string; state: string }> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (Date.now() >= deadline) {
      throw new ProviderError(
        "unknown",
        "Render deployment timed out after 120s. Check the Render dashboard — the build may still be running.",
        "render"
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${RENDER_API_BASE}/services/${serviceId}/deploys/${deployId}`,
        {
          headers: {
            Authorization: `Bearer ${renderToken}`,
            Accept: "application/json",
          },
        }
      );
    } catch (err) {
      throw new ProviderError(
        "network",
        "Could not reach render. Check your internet connection and try again.",
        "render"
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw parseProviderError(response.status, body, "render");
    }

    const data = (await response.json()) as { deploy: { id: string; status: string } };
    const status = data.deploy.status;

    if (status === "live") {
      return { url: `https://dashboard.render.com/web/${serviceId}`, state: "live" };
    }

    if (
      status === "build_failed" ||
      status === "update_failed" ||
      status === "canceled" ||
      status === "deactivated"
    ) {
      throw new ProviderError(
        "unknown",
        `Render deployment failed (status: ${status}). Check the Render dashboard for build logs.`,
        "render"
      );
    }

    // Not yet in a terminal state — wait before polling again
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
