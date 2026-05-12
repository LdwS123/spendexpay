/**
 * list_subscriptions — show every recurring charge tracked for the user.
 *
 * Read-only introspection tool. Returns the user's full set of subscriptions
 * (active, paused, cancelled, past_due) so an agent can answer "what am I
 * paying for every month?" without forcing the user to open the dashboard.
 * Pair with `cancel_subscription` when the agent finds a subscription the
 * user wants to stop.
 *
 * No payment side-effects — never moves money or mutates state.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEV_MODE } from "../config.js";
import {
  listSubscriptionsForUser,
  type SubscriptionRecord,
} from "../lib/db.js";
import { authenticateToolCall } from "../lib/tool-auth.js";

const ListSubscriptionsInput = z.object({
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

function formatSubscription(sub: SubscriptionRecord): string {
  const status = sub.status.toUpperCase();
  const lines = [
    `- ${sub.service} — $${sub.amount_usd.toFixed(2)} / ${sub.interval} [${status}]`,
    `  ID: ${sub.id}`,
  ];
  if (sub.description) {
    lines.push(`  Description: ${sub.description}`);
  }
  if (sub.status === "active") {
    lines.push(`  Next charge: ${sub.next_charge_at}`);
  } else if (sub.status === "paused") {
    lines.push(`  Paused; next scheduled charge was: ${sub.next_charge_at}`);
  } else if (sub.status === "cancelled") {
    lines.push(`  Cancelled at: ${sub.cancelled_at ?? sub.updated_at}`);
  } else if (sub.status === "past_due") {
    lines.push(`  Past due — last attempted charge: ${sub.next_charge_at}`);
  }
  return lines.join("\n");
}

export function registerListSubscriptionsTool(server: McpServer): void {
  server.tool(
    "list_subscriptions",
    "List every recurring charge tracked for the user — active, paused, " +
    "cancelled, or past_due. Read-only; never moves money. Use BEFORE " +
    "asking the user about their recurring spend, or to find a " +
    "subscription_id for `cancel_subscription`.",
    ListSubscriptionsInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] list_subscriptions called.\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n` +
          `\n` +
          `Simulated subscriptions:\n` +
          `- vercel — $20.00 / monthly [ACTIVE]\n` +
          `  ID: 00000000-0000-0000-0000-000000000001\n` +
          `  Next charge: ${new Date(Date.now() + 7 * 86400000).toISOString()}\n` +
          `- spotify — $9.99 / monthly [ACTIVE]\n` +
          `  ID: 00000000-0000-0000-0000-000000000002\n` +
          `  Next charge: ${new Date(Date.now() + 14 * 86400000).toISOString()}\n` +
          `\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to see real data.`
        );
      }

      const auth = await authenticateToolCall(input.mcp_token);
      if (!auth.ok) return auth.response;
      const { user } = auth;

      let subscriptions: SubscriptionRecord[];
      try {
        subscriptions = await listSubscriptionsForUser(user.id);
      } catch (err) {
        return textResponse(
          `Could not load subscriptions: ${errorMessage(err, "unknown error")}.`,
          { isError: true }
        );
      }

      if (subscriptions.length === 0) {
        return textResponse(
          `No subscriptions yet. Use subscribe_service to track a recurring charge.`
        );
      }

      const active = subscriptions.filter((s) => s.status === "active");
      const totalMonthly = active.reduce((sum, s) => {
        // Normalise every active subscription to a monthly figure so the
        // summary line is comparable across intervals.
        switch (s.interval) {
          case "monthly":
            return sum + s.amount_usd;
          case "yearly":
            return sum + s.amount_usd / 12;
          case "weekly":
            // 52 weeks / 12 months ≈ 4.345 weeks per month.
            return sum + s.amount_usd * (52 / 12);
        }
      }, 0);

      const header =
        `You have ${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"} ` +
        `(${active.length} active). ` +
        `Estimated monthly recurring spend: $${totalMonthly.toFixed(2)}.`;

      return textResponse(
        `${header}\n\n` +
        subscriptions.map(formatSubscription).join("\n\n")
      );
    }
  );
}
