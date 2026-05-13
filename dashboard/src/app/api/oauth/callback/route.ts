/**
 * OAuth callback handler — receives the redirect from GitHub / Google.
 *
 * SCAFFOLD ONLY. The MCP-side broker (src/lib/oauth-broker/) is still
 * stubbed. This route exists so the redirect URI registered with the
 * providers is stable: we point GitHub and Google at
 *
 *   https://<dashboard>/api/oauth/callback?provider=github
 *
 * and they redirect back here with `?code=…&state=…`. Once the broker's
 * `handleCallback()` is live, this route simply wires the inputs into
 * it and redirects the user back to `/dashboard/settings/connections`
 * with a success banner.
 *
 * The handler is defensive on purpose:
 *
 *   - GET only. OAuth providers never POST to the redirect URI.
 *   - `provider` must be one of the closed enum values; anything else is
 *     400. Accepting unknown providers here would mean accepting unknown
 *     `state` semantics, which weakens CSRF defense.
 *   - `code` and `state` MUST both be present. If `error` is set instead
 *     (user denied, scope rejected, etc.) we surface a friendly message
 *     and bounce back to the connections page.
 *
 * NOTE: this is a dashboard-side handler, NOT part of the MCP stdio
 * process — there is no stdout-is-sacred constraint here, but we keep
 * `console.error` for grep parity with the rest of the project.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SUPPORTED_PROVIDERS = new Set(["github", "google"]);

/**
 * Build a redirect to the connections settings page with a query-string
 * banner. Wrapped in a helper so the success and error branches stay
 * symmetrical and the URL construction is in one place.
 */
function redirectToConnections(
  request: NextRequest,
  status: "connected" | "error",
  detail?: string
): NextResponse {
  const url = new URL("/dashboard/settings/connections", request.url);
  url.searchParams.set("oauth", status);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const provider = params.get("provider");
  const code = params.get("code");
  const state = params.get("state");
  const providerError = params.get("error");

  // Provider-side error (user denied, scope rejected, etc.) takes precedence
  // over our own validation — if GitHub said "no", showing a "missing code"
  // message would be misleading.
  if (providerError) {
    console.error(
      `[oauth-callback] provider returned error for provider=${provider}: ${providerError}`
    );
    return redirectToConnections(request, "error", providerError);
  }

  if (!provider || !SUPPORTED_PROVIDERS.has(provider)) {
    console.error(
      `[oauth-callback] missing or unsupported provider param: ${provider}`
    );
    return redirectToConnections(request, "error", "unsupported_provider");
  }

  if (!code || !state) {
    console.error(
      `[oauth-callback] missing code or state (code=${!!code} state=${!!state})`
    );
    return redirectToConnections(request, "error", "missing_code_or_state");
  }

  // TODO(oauth-broker): import oauthBroker.handleCallback from the MCP server
  // package once the broker is live. The dashboard and MCP server share the
  // same Supabase DB, so a single broker module is the right home for the
  // exchange — this route just adapts the HTTP layer to it.
  //
  //   import { handleCallback } from "@spendexpay/mcp/oauth-broker";
  //   const connection = await handleCallback(provider, code, state);
  //   return redirectToConnections(request, "connected");
  //
  // Today we surface a clear "not yet wired" banner so QA flows during
  // staging make the missing piece obvious instead of looking like a bug.
  console.error(
    `[oauth-callback] stub: would call broker.handleCallback(provider=${provider}, code=***, state=***)`
  );

  return redirectToConnections(request, "error", "broker_not_wired");
}
