import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken, logTransaction } from "../lib/db.js";
import { acquireIdempotencyKey, releaseIdempotencyKey } from "../lib/idempotency.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const SubscribeServiceInput = z.object({
  service_name: z.string().min(1).describe("Name of the service to subscribe to (e.g. 'vercel', 'modal', 'cursor')"),
  plan_name: z.string().min(1).describe("Plan to subscribe to (e.g. 'pro', 'team')"),
  amount_usd: z.number().positive().describe("Monthly cost of the plan in USD"),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
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

export function registerSubscribeServiceTool(server: McpServer): void {
  server.tool(
    "subscribe_to_service",
    "[Legacy fallback — prefer pay_for_service for new integrations] Subscribe to a service plan on behalf of the user (e.g. Vercel Pro, Cursor Business). Handles payment automatically.",
    SubscribeServiceInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] subscribe_to_service called.\n` +
          `Service: ${input.service_name}\n` +
          `Plan: ${input.plan_name}\n` +
          `Amount: $${input.amount_usd.toFixed(2)}/month\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method $${input.amount_usd.toFixed(2)} and activate the ${input.plan_name} plan on ${input.service_name}.\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
        );
      }

      // Rate limit runs before auth — prevents timing-based token probing
      // and protects the DB from runaway agents.
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
          "Spendex Pay is temporarily paused for maintenance. Please try again later or subscribe manually.",
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

      // Refuse if the subscription cost exceeds the user's auto-approve threshold.
      // Never prompt the user inline — the agent must surface this to them instead.
      if (
        user.max_auto_charge_usd > 0 &&
        input.amount_usd > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This subscription would charge $${input.amount_usd.toFixed(2)}/month but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      // Guard against duplicate in-flight requests for the same user+service+plan.
      const stableKey = `${user.id}-subscribe-${input.service_name}-${input.plan_name}`;
      if (!acquireIdempotencyKey(stableKey)) {
        return textResponse(
          "A subscription request for this service plan is already in progress. Please wait for it to complete before retrying.",
          { isError: true }
        );
      }

      try {
        const subscribeDescription = `Subscribe to ${input.service_name} ${input.plan_name} plan ($${input.amount_usd.toFixed(2)}/month)`;
        // Millisecond timestamp ensures each attempt gets a fresh idempotency key,
        // so Stripe re-runs the charge rather than returning a cached failure.
        const idempotencyKey = `${user.id}-subscribe-${input.service_name}-${input.plan_name}-${Date.now()}`;

        let transactionId: string | null = null;

        try {
          const charge = await routePayment({
            userId: user.id,
            paymentMethod: user.payment_method,
            providerCustomerId: user.payment_provider_customer_id,
            amountUsd: input.amount_usd,
            description: subscribeDescription,
            idempotencyKey,
            transactionType: "subscription",
            metadata: {
              service: input.service_name,
              plan: input.plan_name,
              transaction_type: "subscription",
            },
          });

          transactionId = charge.transactionId;
        } catch (err) {
          const message = errorMessage(err, "Unknown payment error");
          await logTransaction({
            userId: user.id,
            service: input.service_name,
            status: "payment_failed",
            amountUsd: input.amount_usd,
            description: subscribeDescription,
            transactionType: "subscription",
            error: message,
          });

          return textResponse(
            `Payment failed: ${message}. Your account was not charged. Check your payment method at spendexai.com/billing.`,
            { isError: true }
          );
        }

        await logTransaction({
          userId: user.id,
          service: input.service_name,
          status: "success",
          amountUsd: input.amount_usd,
          transactionId: transactionId ?? undefined,
          description: subscribeDescription,
          transactionType: "subscription",
        });

        const txn = transactionId ?? "unknown";
        return textResponse(
          `Subscribed to ${input.service_name} ${input.plan_name} plan. ` +
          `Charged $${input.amount_usd.toFixed(2)} (transaction: ${txn}). ` +
          `Manage your subscription at spendexai.com/dashboard.`
        );
      } finally {
        releaseIdempotencyKey(stableKey);
      }
    }
  );
}
