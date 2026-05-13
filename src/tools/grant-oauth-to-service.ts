/**
 * grant_oauth_to_service — bridge a downstream "Continue with X" button.
 *
 * SCAFFOLD ONLY. The underlying broker (src/lib/oauth-broker/) is still
 * stubbed, so today this tool emits a structured plan the agent can follow
 * without yet performing the real OAuth handshake. The real flow lands in
 * a follow-up pass; the tool surface and registration are wired now so MCP
 * clients can discover the tool and start integrating against it.
 *
 * Why a dedicated tool instead of folding OAuth into `signup_to_service`:
 *
 *   - Many merchants offer BOTH email/password AND OAuth signup paths. The
 *     agent decides per-merchant which is faster; only the OAuth branch
 *     needs the broker. Keeping them split avoids a 200-line conditional
 *     inside `signup_to_service`.
 *
 *   - OAuth grants happen on the user's *existing* Spendex-stored identity
 *     (their GitHub, their Google) rather than spinning up a fresh email
 *     alias. The audit-log semantics differ: an OAuth grant is a delegation,
 *     not a new account.
 *
 *   - Some flows (e.g. Cursor with "Continue with GitHub", later: Vercel SSO)
 *     never create a separate password at all. For those, `signup_to_service`
 *     is the wrong tool entirely.
 *
 * Expected usage:
 *
 *   1. Agent recognizes a downstream service requires OAuth ("Continue with
 *      GitHub / Google").
 *   2. Agent calls `request_user_consent` (action="grant_oauth_to_service").
 *   3. On approval, agent calls THIS tool with `{ service_id, oauth_provider }`.
 *   4. Tool returns a short-lived access token + step-by-step instructions
 *      for the host's browser tool to drive the merchant's OAuth flow.
 *   5. Agent completes the merchant's "Continue with X" handshake.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken } from "../lib/db.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import {
  getAccessToken,
  type OAuthProvider,
} from "../lib/oauth-broker/index.js";

const MCP_TOKEN_PATTERN = /^spx_[0-9a-f]{32}$/;

const Input = z.object({
  service_id: z
    .string()
    .min(1)
    .describe(
      "Slug of the downstream service the agent is signing up for " +
      "(e.g. 'cursor', 'vercel', 'linear'). Used for the audit log and to " +
      "scope future tool calls — not for the OAuth handshake itself."
    ),
  oauth_provider: z
    .enum(["github", "google"])
    .describe(
      "Which provider the downstream service's 'Continue with …' button " +
      "calls into. Spendex must already hold a pre-authorized refresh " +
      "token for this provider (granted by the user during onboarding)."
    ),
  scopes: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional minimum scopes the downstream grant requires. If the " +
      "user's stored connection doesn't cover them, the tool refuses and " +
      "asks for a re-grant — never a silent scope upgrade."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function formatGrantPlan(params: {
  serviceId: string;
  provider: OAuthProvider;
  // accessToken NEVER printed in the message body — agents pull it from a
  // structured field via the host's tool layer. The plaintext access token
  // is opaque to the user and should not be displayed in chat.
}): string {
  const { serviceId, provider } = params;
  return (
    `OAUTH GRANT READY\n` +
    `\n` +
    `Service: ${serviceId}\n` +
    `Provider: ${provider}\n` +
    `\n` +
    `1. Open ${serviceId}'s signup or login page in the host browser tool.\n` +
    `2. Click "Continue with ${provider}".\n` +
    `3. The merchant will redirect to ${provider}.com's OAuth screen. Because\n` +
    `   Spendex already holds a pre-authorized session, the screen should\n` +
    `   either auto-confirm or show a single "Authorize ${serviceId}" button.\n` +
    `4. Approve. The merchant receives the OAuth callback and finishes signup.\n` +
    `5. After the merchant shows a confirmation screen, call\n` +
    `   complete_signup with the merchant-side account ID.\n`
  );
}

// ---------------------------------------------------------------------------
// DEV-mode response
// ---------------------------------------------------------------------------

function formatDevResponse(serviceId: string, provider: OAuthProvider): string {
  return (
    `[DEV MODE] grant_oauth_to_service called.\n` +
    `Service: ${serviceId}\n` +
    `Provider: ${provider}\n` +
    `\n` +
    `OAUTH GRANT READY (simulated)\n` +
    `\n` +
    `In production this would:\n` +
    `  1. Look up the user's pre-authorized ${provider} refresh token.\n` +
    `  2. Exchange it for a short-lived access token via the broker.\n` +
    `  3. Hand the access token to the agent so the host's browser tool can\n` +
    `     complete the "Continue with ${provider}" flow at ${serviceId}.\n` +
    `\n` +
    `Set SPENDEX_DEV=false (and complete the OAuth onboarding) to go live.`
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGrantOAuthToServiceTool(server: McpServer): void {
  server.tool(
    "grant_oauth_to_service",
    "Bridge a downstream service's 'Continue with GitHub' or 'Continue with " +
    "Google' button using the user's pre-authorized Spendex OAuth session. " +
    "Returns a short-lived access token + step-by-step instructions for the " +
    "agent's browser tool to complete the merchant's OAuth handshake without " +
    "the user leaving the chat. " +
    "Call this AFTER `request_user_consent` (action=grant_oauth_to_service) " +
    "and BEFORE driving the merchant's signup page. " +
    "Typical flow: request_user_consent → grant_oauth_to_service → run the " +
    "merchant's 'Continue with X' button → complete_signup.",
    Input.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          formatDevResponse(input.service_id, input.oauth_provider)
        );
      }

      // Rate limit before any DB read — see signup-to-service.ts for the
      // rationale. Same token bucket protects this tool from probe + flood.
      const rateLimit = checkRateLimit(input.mcp_token);
      if (!rateLimit.allowed) {
        const waitSeconds = Math.ceil((rateLimit.retryAfterMs ?? 0) / 1000);
        return textResponse(
          `Too many requests. Please wait ${waitSeconds} second${waitSeconds === 1 ? "" : "s"} before trying again.`,
          { isError: true }
        );
      }

      if (config.emergencyStop) {
        return textResponse(
          "Spendex Pay is temporarily paused for maintenance. Please try again later.",
          { isError: true }
        );
      }

      if (!MCP_TOKEN_PATTERN.test(input.mcp_token)) {
        return textResponse(
          "Invalid MCP token format. A Spendex token looks like `spx_…` " +
          "(32 hex chars). Get yours at spendexai.com/dashboard/tokens.",
          { isError: true }
        );
      }

      const user = await getUserByMcpToken(input.mcp_token);
      if (!user) {
        return textResponse(
          "Invalid or expired MCP token. Please reconnect at spendexai.com/connect.",
          { isError: true }
        );
      }

      // The broker call is the real work. Today it throws "not yet
      // implemented" — that's correct: live OAuth lands in the follow-up
      // pass. Catch the stub error and surface a clear "onboarding needed"
      // message rather than a stack trace.
      try {
        await getAccessToken(
          user.id,
          input.oauth_provider,
          input.scopes ?? []
        );
      } catch (err) {
        const msg = errorMessage(err, "unknown error");
        // TODO(oauth-broker): once the broker is live, differentiate:
        //   - "no connection" → user must onboard at /dashboard/settings/connections
        //   - "scope mismatch" → re-grant required with wider scope
        //   - "refresh failed" → provider revoked Spendex, user must reconnect
        return textResponse(
          `OAuth broker is not yet active for ${input.oauth_provider}. ` +
          `Have the user connect ${input.oauth_provider} once at ` +
          `spendexai.com/dashboard/settings/connections — after that, ` +
          `this tool will hand back a short-lived access token. ` +
          `(broker said: ${msg})`,
          { isError: true }
        );
      }

      return textResponse(
        formatGrantPlan({
          serviceId: input.service_id,
          provider: input.oauth_provider,
        })
      );
    }
  );
}
