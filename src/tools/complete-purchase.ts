/**
 * complete_purchase — close the loop after a Computer-Use checkout.
 *
 * The sibling tool to `prepare_amazon_checkout` (and any future merchant
 * playbook). After the agent has driven the browser through checkout and
 * captured the merchant-side order ID, it calls this tool so Spendex can:
 *
 *   1. Persist an `order_completed` audit-log row tying the merchant order
 *      ID to the user's wallet. This is what makes the order show up in the
 *      dashboard's transactions feed when the user goes looking for it.
 *   2. Record the observed amount so the monthly-spend computation matches
 *      the eventual Stripe Issuing authorization (which lands seconds to
 *      hours later). The two rows can be reconciled by service + amount +
 *      timestamp; we deliberately do not try to predict the auth ID here.
 *
 * No money moves through this tool. The actual charge is captured by the
 * Stripe Issuing webhook when the merchant authorizes the virtual card.
 *
 * Idempotency: the `external_order_id` is recorded verbatim in
 * `audit_logs.transaction_id`. Two calls for the same order ID will produce
 * two rows — by design — because we cannot, from here, distinguish a benign
 * retry from a legitimate second purchase (Amazon sometimes splits one
 * shopping session across multiple orders). The dashboard de-duplicates by
 * (transaction_id, transaction_type) when displaying receipts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import { logTransaction } from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

const CompletePurchaseInput = z.object({
  merchant: z
    .string()
    .min(1)
    .describe(
      "Normalized merchant slug — same shape as the `service` field on " +
      "pay_for_service (e.g. 'amazon', 'ebay', 'walmart')."
    ),
  external_order_id: z
    .string()
    .min(1)
    .describe(
      "The merchant-side order identifier the agent captured at the end of " +
      "checkout (e.g. 'XXX-XXXXXXX-XXXXXXX' for Amazon). Stored verbatim in " +
      "the audit log so the user can cross-reference it on the merchant's site."
    ),
  amount_usd: z
    .number()
    .nonnegative()
    .describe(
      "Final observed order total in USD, including taxes and shipping. " +
      "Used for monthly-spend reconciliation against the Stripe Issuing " +
      "authorization that will land seconds-to-hours later."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

function formatConfirmation(params: {
  merchant: string;
  externalOrderId: string;
  amountUsd: number;
}): string {
  return (
    `ORDER RECORDED\n` +
    `Merchant: ${params.merchant}\n` +
    `Order ID: ${params.externalOrderId}\n` +
    `Amount: $${params.amountUsd.toFixed(2)}\n` +
    `\n` +
    `Spendex has linked this order to the user's wallet. The matching Stripe ` +
    `Issuing authorization will land when ${params.merchant} settles the ` +
    `card; the dashboard's transactions page will reconcile both rows.`
  );
}

function formatDevResponse(input: z.infer<typeof CompletePurchaseInput>): string {
  return (
    `[DEV MODE] complete_purchase called.\n` +
    `\n` +
    formatConfirmation({
      merchant: input.merchant,
      externalOrderId: input.external_order_id,
      amountUsd: input.amount_usd,
    })
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCompletePurchaseTool(server: McpServer): void {
  server.tool(
    "complete_purchase",
    "Record that an external merchant order has been placed by a Computer-Use " +
    "agent, after a playbook tool like prepare_amazon_checkout. Writes an " +
    "audit-log row tying the merchant order ID and observed amount to the " +
    "user's wallet. Does NOT move money — the actual charge arrives via the " +
    "Stripe Issuing authorization webhook when the merchant settles the " +
    "virtual card. Call this exactly once per placed order; duplicate calls " +
    "produce duplicate rows (the dashboard de-duplicates on display).",
    CompletePurchaseInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(formatDevResponse(input));
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      try {
        await logTransaction({
          userId: user.id,
          service: input.merchant,
          status: "success",
          amountUsd: input.amount_usd,
          description: `Order ${input.external_order_id} placed at ${input.merchant}`,
          transactionId: input.external_order_id,
          transactionType: "order_completed",
        });
      } catch (logErr) {
        return textResponse(
          `Could not record order completion: ${errorMessage(logErr, "unknown error")}. ` +
          `The Stripe Issuing webhook will still capture the charge when the merchant settles, ` +
          `but this order will not appear linked to your wallet until the audit row is written.`,
          { isError: true }
        );
      }

      return textResponse(
        formatConfirmation({
          merchant: input.merchant,
          externalOrderId: input.external_order_id,
          amountUsd: input.amount_usd,
        })
      );
    }
  );
}
