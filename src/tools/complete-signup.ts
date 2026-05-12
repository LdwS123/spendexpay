/**
 * complete_signup — close the loop on an auto-signup flow.
 *
 * After `signup_to_service` issued credentials and the agent successfully
 * registered the account at the merchant, the agent calls this tool to:
 *
 *   1. Flip the `managed_accounts.status` from 'pending' → 'active'.
 *   2. Store the merchant-assigned account ID (Vercel team id, Modal
 *      workspace id, etc.) so downstream tools can reference it.
 *   3. Write an audit-log entry so the user can see the new managed account
 *      in their dashboard transactions feed.
 *
 * The tool does NOT verify the account actually exists at the merchant —
 * that would require a per-merchant integration and undermines the point of
 * "any service via Computer Use". The agent is trusted to call this only
 * after it has seen the merchant's "account created" confirmation screen.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import {
  getManagedAccount,
  getUserByMcpToken,
  logTransaction,
  updateManagedAccountStatus,
} from "../lib/db.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const MCP_TOKEN_PATTERN = /^spx_[0-9a-f]{32}$/;

const Input = z.object({
  managed_account_id: z
    .string()
    .uuid()
    .describe(
      "The UUID returned by signup_to_service for the account that was " +
      "just successfully created at the merchant."
    ),
  external_account_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional: the merchant-side ID for this account (e.g. Vercel " +
      "team id, Modal workspace id). Stored alongside the managed account " +
      "row so downstream tools can use it."
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

function formatDevResponse(service: string): string {
  return (
    `[DEV MODE] complete_signup called.\n` +
    `\n` +
    `OK. Account ${service} marked as active in Spendex.`
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCompleteSignupTool(server: McpServer): void {
  server.tool(
    "complete_signup",
    "Finalize an auto-signup flow by flipping a managed account from " +
    "'pending' to 'active'. Call this ONLY after the merchant has shown an " +
    "account-created confirmation screen (or equivalent success state). " +
    "Optionally pass the merchant's external account ID (Vercel team id, " +
    "Modal workspace id, …) so downstream tools can reference it. " +
    "Do NOT call this preemptively — an account marked active before the " +
    "merchant has actually created it will break later `pay_for_service` " +
    "calls.",
    Input.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(formatDevResponse("vercel"));
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

      // Ownership check before mutation — never let one user mark another
      // user's managed_account as active. Returning null for both
      // "not found" and "belongs to someone else" is intentional.
      const managed = await getManagedAccount(input.managed_account_id, user.id);
      if (!managed) {
        return textResponse(
          "Managed account not found for this token. " +
          "Check the ID returned by signup_to_service.",
          { isError: true }
        );
      }

      try {
        await updateManagedAccountStatus(
          input.managed_account_id,
          "active",
          input.external_account_id
        );
      } catch (err) {
        return textResponse(
          `Could not mark account as active: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }

      // Audit log: makes the new managed account visible in the dashboard
      // transactions feed. Non-fatal on write failure — the state change
      // succeeded, we just won't have a paper trail row for it.
      try {
        await logTransaction({
          userId: user.id,
          service: managed.service,
          status: "success",
          amountUsd: 0,
          description: `Managed account activated${
            input.external_account_id ? ` (external id: ${input.external_account_id})` : ""
          }`,
          transactionType: "managed_signup",
          agentId: managed.id,
        });
      } catch (logErr) {
        console.error(
          `[complete_signup] audit log write failed for managed_account ${managed.id}: ` +
          `${errorMessage(logErr, "unknown error")}`
        );
      }

      return textResponse(
        `OK. Account ${managed.service} marked as active in Spendex.`
      );
    }
  );
}
