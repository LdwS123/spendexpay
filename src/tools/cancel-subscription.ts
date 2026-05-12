/**
 * cancel_subscription — stop a recurring charge.
 *
 * Counterpart to `subscribe_service`. Transitions a subscriptions row to
 * status='cancelled' and stamps cancelled_at. Idempotent: cancelling a row
 * that is already cancelled returns the row unchanged with a clear message.
 * Ownership is enforced server-side via the (id, user_id) filter so a stolen
 * subscription ID cannot be used to cancel a row that does not belong to
 * the calling user.
 *
 * The V3 renewal cron checks status before firing, so cancelling here is
 * sufficient to halt future charges — no merchant-side API call is made.
 * (When we add native subscription integrations the merchant call will be
 * layered on top of this state transition, not replace it.)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import {
  cancelSubscription,
  getSubscription,
  logTransaction,
} from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

const CancelSubscriptionInput = z.object({
  subscription_id: z
    .string()
    .uuid()
    .describe(
      "ID of the subscription to cancel. Returned by `subscribe_service` or " +
      "`list_subscriptions`."
    ),
  mcp_token: z
    .string()
    .min(1)
    .describe("Your Spendex MCP token (starts with spx_)."),
});

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

export function registerCancelSubscriptionTool(server: McpServer): void {
  server.tool(
    "cancel_subscription",
    "Cancel an active or paused subscription. Stops future renewals — no " +
    "more charges will be made for this subscription. Idempotent: a " +
    "subscription that is already cancelled returns success unchanged. " +
    "Use `list_subscriptions` first if you do not have the subscription_id.",
    CancelSubscriptionInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] cancel_subscription called.\n` +
          `Subscription ID: ${input.subscription_id}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n` +
          `\n` +
          `SUBSCRIPTION CANCELLED (simulated). No further charges will be made.\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
        );
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      // Verify ownership before any mutation. getSubscription returns null
      // for both "not found" and "owned by someone else" — indistinguishable
      // from the caller's perspective so an attacker can't probe IDs.
      const existing = await getSubscription(input.subscription_id, user.id);
      if (!existing) {
        return textResponse(
          `No subscription found with ID ${input.subscription_id}. ` +
          `Use list_subscriptions to see your active subscriptions.`,
          { isError: true }
        );
      }

      // Already cancelled — return success without mutating. Keeps the tool
      // idempotent so an agent retrying a flaky call doesn't get a confusing
      // "not found" error after the first call already succeeded.
      if (existing.status === "cancelled") {
        return textResponse(
          `Subscription ${existing.id} (${existing.service}, ` +
          `$${existing.amount_usd.toFixed(2)}) was already cancelled at ` +
          `${existing.cancelled_at ?? existing.updated_at}. No action taken.`
        );
      }

      let cancelled;
      try {
        cancelled = await cancelSubscription(input.subscription_id, user.id);
      } catch (err) {
        return textResponse(
          `Could not cancel subscription: ${errorMessage(err, "unknown error")}. ` +
          `The subscription is still active.`,
          { isError: true }
        );
      }

      if (!cancelled) {
        // Race: the row was deleted/cancelled between our existence check and
        // the update. Treat it as a soft success — the agent's intent has
        // been satisfied (the subscription is no longer active).
        return textResponse(
          `Subscription ${input.subscription_id} is no longer active. ` +
          `No further charges will be made.`
        );
      }

      // Audit log — amountUsd=0 so the cancellation event itself does NOT
      // count against monthly spend totals. The agent_id field carries the
      // subscription_id so dispute resolution can trace it.
      await logTransaction({
        userId: user.id,
        service: cancelled.service,
        status: "success",
        amountUsd: 0,
        description: `Cancelled subscription: ${cancelled.description ?? cancelled.service} ` +
          `($${cancelled.amount_usd.toFixed(2)})`,
        transactionType: "subscription_cancel",
        agentId: cancelled.id,
      });

      return textResponse(
        `SUBSCRIPTION CANCELLED.\n` +
        `\n` +
        `Service: ${cancelled.service}\n` +
        `Amount: $${cancelled.amount_usd.toFixed(2)} / ${cancelled.interval}\n` +
        `Cancelled at: ${cancelled.cancelled_at ?? cancelled.updated_at}\n` +
        `\n` +
        `No further charges will be made for this subscription.`
      );
    }
  );
}
