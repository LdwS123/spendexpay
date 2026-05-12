/**
 * submit_consent_decision — record the user's choice on an outstanding
 * consent request returned by `request_user_consent`.
 *
 * The agent surfaces the structured prompt to the user inline in chat,
 * collects the user's response (text or button click), and calls this
 * tool with the chosen option slug. We CAS-update the row from 'pending'
 * to 'approved' or 'declined' and return a short confirmation that the
 * agent can use to either proceed with the action or abort.
 *
 * Concurrency: `recordConsentDecision` updates only when the row is still
 * pending, so a duplicate submit (e.g. user clicked twice) cannot
 * overwrite a recorded choice. Missing / not-yours / already-decided /
 * expired rows are all surfaced with distinct user-facing messages.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import {
  getConsentRequest,
  getUserByMcpToken,
  recordConsentDecision,
  type ConsentRequestRecord,
} from "../lib/db.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const MCP_TOKEN_PATTERN = /^spx_[0-9a-f]{32}$/;

const SubmitConsentInput = z.object({
  consent_id: z
    .string()
    .uuid()
    .describe(
      "The consent request UUID returned by request_user_consent."
    ),
  decision: z
    .string()
    .min(1)
    .describe(
      "The option slug the user picked. Must be one of the options listed " +
      "on the consent_requests row (e.g. 'approve', 'decline', " +
      "'auto_create_dedicated_email')."
    ),
  decision_metadata: z
    .record(z.unknown())
    .optional()
    .describe(
      "Free-form context attached to the decision for the audit trail " +
      "(e.g. {\"source\":\"chat_button\"}). Optional."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

type SubmitConsentInputType = z.infer<typeof SubmitConsentInput>;

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

function formatRecorded(row: ConsentRequestRecord): string {
  const guidance =
    row.status === "approved"
      ? "You may now proceed with the action."
      : "Do NOT proceed. Ask the user how they'd like to handle this differently.";

  return (
    `CONSENT RECORDED\n` +
    `Decision: ${row.decision ?? "(unknown)"}\n` +
    `Status: ${row.status}\n` +
    `Consent ID: ${row.id}\n` +
    `Decided at: ${row.decision_made_at ?? new Date().toISOString()}\n` +
    `\n` +
    guidance
  );
}

function formatDevResponse(input: SubmitConsentInputType): string {
  const status = input.decision === "decline" ? "declined" : "approved";
  return (
    `[DEV MODE] submit_consent_decision called.\n` +
    `Consent ID: ${input.consent_id}\n` +
    `Decision: ${input.decision}\n` +
    `\n` +
    `CONSENT RECORDED\n` +
    `Decision: ${input.decision}\n` +
    `Status: ${status}\n` +
    `Decided at: ${new Date().toISOString()}\n` +
    `\n` +
    (status === "approved"
      ? "You may now proceed with the action."
      : "Do NOT proceed. Ask the user how they'd like to handle this differently.")
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSubmitConsentDecisionTool(server: McpServer): void {
  server.tool(
    "submit_consent_decision",
    "Record the user's response to a pending consent request created by " +
    "`request_user_consent`. Call EXACTLY ONCE per consent_id, after the " +
    "user has actually picked one of the options from the inline prompt — " +
    "never guess or auto-default on the user's behalf. Returns " +
    "CONSENT RECORDED with the final status (approved/declined) so the " +
    "agent knows whether to proceed. If the user has not yet responded, " +
    "use `check_consent_status` instead.",
    SubmitConsentInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(formatDevResponse(input));
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

      // Read the row first so we can return precise errors (already decided,
      // expired, not in options) without a second round-trip.
      const existing = await getConsentRequest(input.consent_id, user.id);
      if (!existing) {
        return textResponse(
          "Consent request not found for this token. " +
          "Check the ID returned by request_user_consent.",
          { isError: true }
        );
      }

      if (existing.status !== "pending") {
        return textResponse(
          `Consent request is already ${existing.status}. ` +
          `Decision recorded earlier: ${existing.decision ?? "(none)"}. ` +
          `No further action accepted.`,
          { isError: true }
        );
      }

      if (new Date(existing.expires_at).getTime() <= Date.now()) {
        return textResponse(
          `Consent request expired at ${existing.expires_at}. ` +
          `Ask the user to retry, or call request_user_consent again.`,
          { isError: true }
        );
      }

      if (!existing.options.includes(input.decision)) {
        return textResponse(
          `Invalid decision "${input.decision}". ` +
          `Must be one of: ${existing.options.map((o) => `"${o}"`).join(", ")}.`,
          { isError: true }
        );
      }

      const status: "approved" | "declined" =
        input.decision === "decline" ? "declined" : "approved";

      let updated: ConsentRequestRecord | null;
      try {
        updated = await recordConsentDecision({
          id: existing.id,
          userId: user.id,
          status,
          decision: input.decision,
          decisionMetadata: input.decision_metadata,
        });
      } catch (err) {
        return textResponse(
          `Could not record consent decision: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }

      if (!updated) {
        // CAS lost: another caller decided in the meantime, or the row
        // lapsed to 'expired' between our read and our update. Re-read so
        // we can report the actual final state.
        const reread = await getConsentRequest(existing.id, user.id);
        if (reread && reread.status !== "pending") {
          return textResponse(
            `Consent request is already ${reread.status}. ` +
            `Decision recorded earlier: ${reread.decision ?? "(none)"}. ` +
            `No further action accepted.`,
            { isError: true }
          );
        }
        return textResponse(
          "Could not record consent decision (no row updated). " +
          "Call check_consent_status to inspect the current state.",
          { isError: true }
        );
      }

      return textResponse(formatRecorded(updated));
    }
  );
}
