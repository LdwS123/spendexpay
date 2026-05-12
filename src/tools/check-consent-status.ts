/**
 * check_consent_status — look up the current state of an outstanding
 * consent request.
 *
 * Used by agents after `request_user_consent` returned CONSENT TIMEOUT but
 * the underlying `consent_requests` row may still receive a decision. The
 * agent passes the consent_id it was handed and gets back the same
 * APPROVED / DECLINED / EXPIRED / PENDING vocabulary as `request_user_consent`.
 *
 * Ownership is enforced: a token cannot read another user's consent rows.
 * Returning "not found" for both "doesn't exist" and "exists but isn't
 * yours" is intentional — it prevents probing valid IDs from a stolen token.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import {
  getConsentRequest,
  getUserByMcpToken,
  type ConsentRequestRecord,
} from "../lib/db.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const MCP_TOKEN_PATTERN = /^spx_[0-9a-f]{32}$/;

const CheckConsentStatusInput = z.object({
  consent_id: z
    .string()
    .uuid()
    .describe(
      "The consent request UUID returned by request_user_consent."
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

function formatStatus(row: ConsentRequestRecord): string {
  const header = (() => {
    switch (row.status) {
      case "approved":
        return "CONSENT APPROVED";
      case "declined":
        return "CONSENT DECLINED";
      case "expired":
        return "CONSENT EXPIRED";
      case "pending":
        return "CONSENT PENDING";
    }
  })();

  const decisionLine =
    row.decision !== null ? `Decision: ${row.decision}\n` : "";
  const decidedAtLine =
    row.decision_made_at !== null
      ? `Decided at: ${row.decision_made_at}\n`
      : "";

  const guidance = (() => {
    switch (row.status) {
      case "approved":
        return "You may now proceed with the action.";
      case "declined":
        return "Do NOT proceed. Ask the user how they'd like to handle this differently.";
      case "expired":
        return "The consent request expired. Ask the user to retry, or call request_user_consent again.";
      case "pending":
        return (
          `Still waiting on the user (expires at ${row.expires_at}). ` +
          `Call check_consent_status again later.`
        );
    }
  })();

  return (
    `${header}\n` +
    decisionLine +
    `Consent ID: ${row.id}\n` +
    decidedAtLine +
    `\n` +
    `${guidance}`
  );
}

function formatDevResponse(consentId: string): string {
  return (
    `[DEV MODE] check_consent_status called.\n` +
    `Consent ID: ${consentId}\n` +
    `\n` +
    `CONSENT APPROVED\n` +
    `Decision: approve\n` +
    `Decided at: ${new Date().toISOString()}\n` +
    `\n` +
    `You may now proceed with the action.`
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCheckConsentStatusTool(server: McpServer): void {
  server.tool(
    "check_consent_status",
    "Poll the current state of a pending consent request created by " +
    "`request_user_consent`. Use when the user stepped away from chat and " +
    "may have approved/declined via email or the dashboard since. Returns " +
    "PENDING, APPROVED, DECLINED, or EXPIRED. Read-only — never mutates " +
    "state. If you ALREADY have the user's choice in chat, call " +
    "`submit_consent_decision` instead.",
    CheckConsentStatusInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(formatDevResponse(input.consent_id));
      }

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

      // Ownership check happens inside getConsentRequest (filters by user_id).
      const row = await getConsentRequest(input.consent_id, user.id);
      if (!row) {
        return textResponse(
          "Consent request not found for this token. " +
          "Check the ID returned by request_user_consent.",
          { isError: true }
        );
      }

      return textResponse(formatStatus(row));
    }
  );
}
