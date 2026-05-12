import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken, logTransaction } from "../lib/db.js";
import { acquireIdempotencyKey, releaseIdempotencyKey } from "../lib/idempotency.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const TopUpServiceInput = z.object({
  service_name: z.string().min(1).describe("Name of the service to add credits to (e.g. 'modal', 'openai', 'anthropic')"),
  amount_usd: z.number().positive().describe("Dollar amount of credits to add"),
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

export function registerTopUpServiceTool(server: McpServer): void {
  server.tool(
    "add_service_credits",
    "[Legacy fallback — prefer pay_for_service for new integrations] Add credits to a developer service (e.g. Modal GPU credits, OpenAI API credits). Handles payment automatically.",
    TopUpServiceInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] add_service_credits called.\n` +
          `Service: ${input.service_name}\n` +
          `Amount: $${input.amount_usd.toFixed(2)}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method $${input.amount_usd.toFixed(2)} and add credits to your ${input.service_name} account.\n` +
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
          "Spendex Pay is temporarily paused for maintenance. Please try again later or add credits manually.",
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

      // Refuse if the top-up amount exceeds the user's auto-approve threshold.
      // Never prompt the user inline — the agent must surface this to them instead.
      if (
        user.max_auto_charge_usd > 0 &&
        input.amount_usd > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This top-up would charge $${input.amount_usd.toFixed(2)} but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      // Guard against duplicate in-flight requests for the same user+service.
      // Uses stable parts only so a retry while the first request is in-flight is correctly rejected.
      const stableKey = `${user.id}-topup-${input.service_name}`;
      if (!acquireIdempotencyKey(stableKey)) {
        return textResponse(
          "A top-up for this service is already in progress. Please wait for it to complete before retrying.",
          { isError: true }
        );
      }

      try {
        const topUpDescription = `Add $${input.amount_usd.toFixed(2)} credits to ${input.service_name}`;
        // Millisecond timestamp ensures each attempt gets a fresh idempotency key,
        // so Stripe re-runs the charge rather than returning a cached failure.
        const idempotencyKey = `${user.id}-topup-${input.service_name}-${Date.now()}`;

        let transactionId: string | null = null;

        try {
          const charge = await routePayment({
            userId: user.id,
            paymentMethod: user.payment_method,
            providerCustomerId: user.payment_provider_customer_id,
            amountUsd: input.amount_usd,
            description: topUpDescription,
            idempotencyKey,
            transactionType: "top_up",
            metadata: {
              service: input.service_name,
              transaction_type: "top_up",
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
            description: topUpDescription,
            transactionType: "top_up",
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
          description: topUpDescription,
          transactionType: "top_up",
        });

        const txn = transactionId ?? "unknown";
        return textResponse(
          `Added $${input.amount_usd.toFixed(2)} credits to ${input.service_name}. ` +
          `Transaction: ${txn}. ` +
          `View your credit balance at spendexai.com/dashboard.`
        );
      } finally {
        releaseIdempotencyKey(stableKey);
      }
    }
  );
}
