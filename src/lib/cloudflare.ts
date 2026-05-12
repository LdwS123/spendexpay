// Uses the user's own Cloudflare API token — Spendex never uses a shared token.
// Each user generates a token at dash.cloudflare.com/profile/api-tokens with
// the "Edit Cloudflare Workers" permission and pastes it into their Spendex
// dashboard once during onboarding, along with their account ID.
//
// Cloudflare Workers deployments are synchronous: the API only returns once
// the new deployment is live, so we do not poll (unlike Vercel/Netlify).
// The Worker script must already be uploaded via wrangler — this endpoint
// only triggers a new deployment of the latest uploaded version.

import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

interface TriggerCloudflareDeployParams {
  workerName: string;
  accountId: string;
  cloudflareToken: string;
}

interface CloudflareDeployResult {
  deploymentId: string;
  previewUrl: string;
}

interface CloudflareDeployResponse {
  result?: {
    id?: string;
    source?: string;
    strategy?: string;
  } | null;
  success: boolean;
  errors?: unknown[];
  messages?: unknown[];
}

export async function triggerCloudflareDeploy(
  params: TriggerCloudflareDeployParams
): Promise<CloudflareDeployResult> {
  const { workerName, accountId, cloudflareToken } = params;

  const url =
    `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}` +
    `/workers/scripts/${encodeURIComponent(workerName)}/deployments`;

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cloudflareToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      "network",
      "Could not reach cloudflare. Check your internet connection and try again.",
      "cloudflare"
    );
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw parseProviderError(response.status, errorBody, "cloudflare");
  }

  const data = (await response.json()) as CloudflareDeployResponse;

  if (data.success === false) {
    throw new ProviderError(
      "unknown",
      `Cloudflare deploy failed: ${JSON.stringify(data.errors ?? []).slice(0, 200)}`,
      "cloudflare"
    );
  }

  const deploymentId = data.result?.id ?? "";

  // We do not get the user's *.workers.dev subdomain back in the deploy
  // response, so we return the Cloudflare dashboard URL for the Worker
  // instead of constructing a guessed preview URL.
  const previewUrl = `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}`;

  return { deploymentId, previewUrl };
}
