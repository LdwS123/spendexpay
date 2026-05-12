/**
 * get_verification_email — poll for a verification email landing at a
 * managed account's alias.
 *
 * After `signup_to_service` returns credentials, the agent runs the merchant's
 * signup form. Most merchants then email a verification link to the address
 * we used — `signup-<hash>@mail.spendexai.com`. Our inbound MX writes those
 * messages to the `inbound_emails` table, and this tool returns the most
 * recent one for the agent's managed account.
 *
 * The poll loop runs server-side so a single MCP call can wait up to a
 * minute for the message instead of forcing the agent to poll in a tight
 * loop and burn rate-limit budget.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import {
  getLatestInboundEmail,
  getManagedAccount,
  getUserByMcpToken,
  type InboundEmailRecord,
} from "../lib/db.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const MCP_TOKEN_PATTERN = /^spx_[0-9a-f]{32}$/;
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 60;

const Input = z.object({
  managed_account_id: z
    .string()
    .uuid()
    .describe(
      "The UUID returned by signup_to_service for the account whose " +
      "verification email you want to read."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
  max_wait_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      `How long to wait for a message before returning NO EMAIL YET. ` +
      `Default ${DEFAULT_WAIT_SECONDS}s, capped at ${MAX_WAIT_SECONDS}s.`
    ),
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

/**
 * Pull the first https URL out of an email body.
 *
 * Verification mails universally include exactly one "click here" link, and
 * that link is almost always the first https URL in the body. We surface it
 * as a structured `verification_link:` field so the agent doesn't have to
 * parse free-form text.
 */
function extractFirstLink(body: string): string | null {
  // Stop at whitespace, quote, or the typical line-wrap markers an email
  // client inserts. Trailing punctuation is stripped so we don't return e.g.
  // "https://vercel.com/api/verify?t=xyz."
  const match = body.match(/https?:\/\/[^\s"'<>)]+/);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/, "");
}

/**
 * Trim an email body for the agent. The full body can be tens of KB of
 * boilerplate; the agent rarely needs more than the first few sentences to
 * understand what the email is asking.
 */
function bodyExcerpt(body: string, maxChars: number = 400): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 1) + "…";
}

function formatEmailFound(email: InboundEmailRecord): string {
  // Prefer the link extracted by the inbound webhook — it knows the exact
  // markup pattern each provider uses (e.g. Vercel's `<a class="verify">`).
  // Only fall back to a regex on body_text when the webhook didn't extract one.
  const link = email.verification_link ?? extractFirstLink(email.body_text);
  const excerpt = bodyExcerpt(email.body_text);

  const codeLine =
    email.verification_code !== null
      ? `Verification code: ${email.verification_code}\n`
      : "";

  return (
    `EMAIL RECEIVED\n` +
    `From: ${email.from_address}\n` +
    `Subject: ${email.subject}\n` +
    `Verification link: ${link ?? "(no link found in body)"}\n` +
    codeLine +
    `Body excerpt: "${excerpt}"`
  );
}

/**
 * DEV-mode: agents calling this tool in dev should still get a believable
 * response so their downstream logic (extracting the link, clicking it) can
 * be exercised. We return a canned verification-email shape.
 */
function formatDevResponse(managedAccountId: string): string {
  return (
    `[DEV MODE] get_verification_email called for ${managedAccountId}.\n` +
    `\n` +
    `EMAIL RECEIVED\n` +
    `From: noreply@example.com\n` +
    `Subject: Verify your email\n` +
    `Verification link: https://example.com/api/verify?token=devtoken\n` +
    `Body excerpt: "Click the link to verify your email address."`
  );
}

// Small sleep helper. Keeps the polling loop readable.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGetVerificationEmailTool(server: McpServer): void {
  server.tool(
    "get_verification_email",
    "Retrieve the most recent verification email sent to a managed " +
    "account's alias (created by `signup_to_service`). Use AFTER submitting " +
    "the merchant's signup form to grab the confirmation link or code. " +
    "Server-side polling waits up to ~30s so the agent does not have to " +
    "loop or burn rate-limit budget. Returns the From/Subject/link/code, " +
    "or `NO EMAIL YET` if nothing arrived in the wait window (in which " +
    "case retry once, then fall back to asking the user).",
    Input.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(formatDevResponse(input.managed_account_id));
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

      // Ownership check — never let one user's MCP token read another user's
      // verification email. `getManagedAccount` returns null both for "not
      // found" and "exists but belongs to another user", which is what we want.
      const managed = await getManagedAccount(input.managed_account_id, user.id);
      if (!managed) {
        return textResponse(
          "Managed account not found for this token. " +
          "Check the ID returned by signup_to_service.",
          { isError: true }
        );
      }

      const waitSeconds = input.max_wait_seconds ?? DEFAULT_WAIT_SECONDS;
      const deadline = Date.now() + waitSeconds * 1000;

      // Poll until the deadline. Each iteration is a single index lookup —
      // the inbound_emails (to_alias, received_at desc) index makes this
      // O(log n) regardless of overall table size.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let email: InboundEmailRecord | null;
        try {
          email = await getLatestInboundEmail(managed.email_alias, managed.created_at);
        } catch (err) {
          return textResponse(
            `Could not query inbound emails: ${errorMessage(err, "unknown error")}.`,
            { isError: true }
          );
        }

        if (email) {
          return textResponse(formatEmailFound(email));
        }

        if (Date.now() >= deadline) break;

        await sleep(POLL_INTERVAL_MS);
      }

      return textResponse(
        `NO EMAIL YET. Try again or check the service directly.`
      );
    }
  );
}
