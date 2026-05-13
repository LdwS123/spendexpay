/**
 * get_sms_code — return the latest unread SMS verification code received
 * on the user's Spendex virtual phone number.
 *
 * Closes the "exit chat to read SMS" gap during signup: Spendex leases a
 * Twilio number per user (see migration 008_virtual_phone.sql), points
 * downstream services at that number, and routes the inbound SMS to
 * `/api/webhooks/twilio-sms`. This tool reads the most recent unconsumed
 * row for the agent's user and atomically marks it consumed.
 *
 * The poll loop runs server-side so a single MCP call can wait up to a
 * minute for the SMS instead of forcing the agent to spin in a tight loop
 * and burn rate-limit budget.
 *
 * TODO: provisioning. We do NOT lease the Twilio number here — that
 * happens during account setup via:
 *   Twilio.api.incomingPhoneNumbers.create({
 *     areaCode: <user_pref>,
 *     smsUrl: "https://app.spendexai.com/api/webhooks/twilio-sms",
 *     smsMethod: "POST",
 *   })
 * and then `insert into virtual_phones(user_id, e164_number, twilio_sid)`.
 * That flow is the next ticket; this tool assumes the row already exists.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import {
  consumeLatestSmsForPhone,
  getActiveVirtualPhone,
  type SmsMessageRecord,
} from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 60;

const Input = z.object({
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
      `How long to wait for a new SMS before returning NO SMS YET. ` +
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

function bodyExcerpt(body: string, maxChars: number = 240): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 1) + "…";
}

function formatSmsFound(sms: SmsMessageRecord, e164: string): string {
  const codeLine =
    sms.extracted_code !== null
      ? `Verification code: ${sms.extracted_code}\n`
      : `Verification code: (none parsed — see body below)\n`;
  return (
    `SMS RECEIVED\n` +
    `To: ${e164}\n` +
    `From: ${sms.from_number}\n` +
    codeLine +
    `Body: "${bodyExcerpt(sms.body)}"`
  );
}

function formatDevResponse(): string {
  return (
    `[DEV MODE] get_sms_code called.\n` +
    `\n` +
    `SMS RECEIVED\n` +
    `To: +15555550100\n` +
    `From: +14155550199\n` +
    `Verification code: 482913\n` +
    `Body: "Your code is 482913. Do not share it."`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGetSmsCodeTool(server: McpServer): void {
  server.tool(
    "get_sms_code",
    "Fetch the latest unread SMS verification code sent to the user's " +
    "Spendex virtual phone number. Use AFTER submitting a signup or login " +
    "form that requires SMS verification — Spendex routes the inbound SMS " +
    "through its own Twilio number so the user never has to leave chat to " +
    "read it. Server-side polling waits up to ~30s. Returns the From/Body " +
    "and the extracted code, or `NO SMS YET` if nothing arrived in the " +
    "wait window (retry once, then fall back to asking the user).",
    Input.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(formatDevResponse());
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      const phone = await getActiveVirtualPhone(user.id);
      if (!phone) {
        return textResponse(
          "No active Spendex virtual phone number for this account. " +
          "A virtual number must be provisioned before SMS-verification flows " +
          "can be intercepted. Contact support or run signup setup.",
          { isError: true }
        );
      }

      const waitSeconds = input.max_wait_seconds ?? DEFAULT_WAIT_SECONDS;
      const deadline = Date.now() + waitSeconds * 1000;

      // Poll until the deadline. Each iteration is a single index lookup
      // against idx_sms_messages_phone_unread, which is a partial index on
      // (virtual_phone_id, consumed_at) WHERE consumed_at IS NULL — O(log n)
      // regardless of overall table size.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const sms = await consumeLatestSmsForPhone(phone.id);
        if (sms) {
          return textResponse(formatSmsFound(sms, phone.e164_number));
        }

        if (Date.now() >= deadline) break;
        await sleep(POLL_INTERVAL_MS);
      }

      return textResponse(
        `NO SMS YET. Try again or fall back to asking the user for the code.`
      );
    }
  );
}
