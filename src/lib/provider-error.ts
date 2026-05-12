export type ProviderErrorCode =
  | "auth"
  | "not_found"
  | "quota"
  | "conflict"
  | "rate_limit"
  | "server_error"
  | "network"
  | "unknown";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly statusCode?: number;
  readonly provider: string;

  constructor(
    code: ProviderErrorCode,
    message: string,
    provider: string,
    statusCode?: number
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

function authMessage(provider: string): string {
  switch (provider) {
    case "vercel":
      return "Your Vercel token is invalid or expired. Generate a new one at vercel.com/account/tokens and update it in your Spendex dashboard.";
    case "netlify":
      return "Your Netlify token is invalid or expired. Generate a new one at app.netlify.com/user/applications and update it in your Spendex dashboard.";
    case "railway":
      return "Your Railway token is invalid or expired. Generate a new one at railway.com/account/tokens and update it in your Spendex dashboard.";
    case "flyio":
      return "Your Fly.io token is invalid or expired. Generate a new one with `flyctl auth token` and update it in your Spendex dashboard.";
    case "replicate":
      return "Your Replicate token is invalid or expired. Generate a new one at replicate.com/account/api-tokens and update it in your Spendex dashboard.";
    case "render":
      return "Your Render token is invalid or expired. Generate a new one at dashboard.render.com/u/account and update it in your Spendex dashboard.";
    case "huggingface":
      return "Your Hugging Face token is invalid or expired. Generate a new one at huggingface.co/settings/tokens (read access is enough for inference) and update it in your Spendex dashboard.";
    case "gamma":
      return "Your Gamma API key is invalid or expired. Generate a new one at gamma.app/account/api and update it in your Spendex dashboard.";
    case "cloudflare":
      return "Your Cloudflare API token is invalid or expired. Generate a new one at dash.cloudflare.com/profile/api-tokens (needs Workers Scripts:Edit permission) and update it in your Spendex dashboard.";
    case "supabase":
      return "Your Supabase personal access token is invalid or expired. Generate a new one at supabase.com/dashboard/account/tokens and update it in your Spendex dashboard.";
    default:
      return `Your ${provider} token is invalid or expired. Generate a new one in your provider account settings and update it in your Spendex dashboard.`;
  }
}

export function parseProviderError(
  status: number,
  body: string,
  provider: string
): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError("auth", authMessage(provider), provider, status);
  }
  if (status === 404) {
    return new ProviderError(
      "not_found",
      `Project not found on ${provider}. Verify the project name/ID matches exactly and your token has access to it.`,
      provider,
      status
    );
  }
  if (status === 402) {
    return new ProviderError(
      "quota",
      `Your ${provider} plan has reached its usage limits. Upgrade your plan or wait for the monthly reset.`,
      provider,
      status
    );
  }
  if (status === 409) {
    return new ProviderError(
      "conflict",
      `A deployment is already in progress on ${provider}. Wait for it to complete before retrying.`,
      provider,
      status
    );
  }
  if (status === 429) {
    return new ProviderError(
      "rate_limit",
      `You are being rate limited by ${provider}. Wait a few seconds and try again.`,
      provider,
      status
    );
  }
  if (status >= 500 && status < 600) {
    return new ProviderError(
      "server_error",
      `The ${provider} service is temporarily unavailable (error ${status}). Try again in a moment.`,
      provider,
      status
    );
  }
  return new ProviderError(
    "unknown",
    `Unexpected response from ${provider} (status ${status}): ${body.slice(0, 200)}`,
    provider,
    status
  );
}
