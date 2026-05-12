import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken, logTransaction } from "../lib/db.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { triggerReplicatePrediction } from "../lib/replicate.js";
import { ProviderError } from "../lib/provider-error.js";

const RunReplicateInput = z.object({
  model_version: z
    .string()
    .min(1)
    .describe("The Replicate model version ID (format: owner/model:sha256hash)"),
  input_json: z
    .string()
    .describe("JSON string of inputs for the model (e.g. '{\"prompt\": \"a cat\"}')"),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
});

const REPLICATE_RUN_COST_USD = 0;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

export function registerRunReplicateTool(server: McpServer) {
  server.tool(
    "run_on_replicate",
    "[Legacy fallback — prefer pay_for_service for new integrations] Run an AI model on Replicate on behalf of the user. Handles payment automatically.",
    RunReplicateInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] run_on_replicate called.\n` +
          `Model version: ${input.model_version}\n` +
          `Input JSON: ${input.input_json}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method, run the Replicate model, and return the output.\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
        );
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
          "Spendex Pay is temporarily paused for maintenance. Please try again later or run manually.",
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

      if (!user.replicate_token) {
        return textResponse(
          "No Replicate API token configured. Add it at spendexai.com/connect.",
          { isError: true }
        );
      }

      // If there's a cost AND the user's auto-approve threshold is non-zero AND
      // the cost exceeds the threshold → refuse and tell the agent to ask the user.
      if (
        REPLICATE_RUN_COST_USD > 0 &&
        user.max_auto_charge_usd > 0 &&
        REPLICATE_RUN_COST_USD > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This action would charge $${REPLICATE_RUN_COST_USD.toFixed(2)} but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      const deployDescription = `Replicate model run: ${input.model_version}`;
      const idempotencyKey = `${user.id}-replicate-${Date.now()}`;

      let transactionId: string | null = null;

      try {
        const charge = await routePayment({
          userId: user.id,
          paymentMethod: user.payment_method,
          providerCustomerId: user.payment_provider_customer_id,
          amountUsd: REPLICATE_RUN_COST_USD,
          description: deployDescription,
          idempotencyKey,
          metadata: {
            service: "replicate",
            model_version: input.model_version,
          },
        });

        transactionId = charge.transactionId;
      } catch (err) {
        const message = errorMessage(err, "Unknown payment error");
        await logTransaction({
          userId: user.id,
          service: "replicate",
          status: "payment_failed",
          amountUsd: REPLICATE_RUN_COST_USD,
          description: deployDescription,
          error: message,
        });

        return textResponse(
          `Payment failed: ${message}. Your account was not charged. Check your payment method at spendexai.com/billing.`,
          { isError: true }
        );
      }

      let outputSummary: string;
      let url: string;

      try {
        const result = await triggerReplicatePrediction({
          modelVersion: input.model_version,
          inputJson: input.input_json,
          replicateToken: user.replicate_token,
        });

        outputSummary = result.outputSummary;
        url = result.url;
      } catch (runErr) {
        const runMessage = runErr instanceof ProviderError
          ? runErr.message
          : errorMessage(runErr, "Unknown run error");
        let auditLogError: Error | null = null;

        try {
          await logTransaction({
            userId: user.id,
            service: "replicate",
            status: "deploy_failed_after_payment",
            amountUsd: REPLICATE_RUN_COST_USD,
            transactionId: transactionId ?? undefined,
            description: deployDescription,
            error: runMessage,
          });
        } catch (logErr) {
          auditLogError = logErr instanceof Error ? logErr : new Error(String(logErr));
        }

        const txn = transactionId ?? "unknown";
        const chargeNote =
          REPLICATE_RUN_COST_USD > 0
            ? ` Your account was charged $${REPLICATE_RUN_COST_USD.toFixed(2)} (transaction: ${txn}). Contact support at spendexai.com/support to request a refund.`
            : " (No charge was made for this run.)";

        const auditNote = auditLogError
          ? ` WARNING: The audit log could not be written (${auditLogError.message}). This charge is not recorded — contact support immediately with transaction ID: ${txn}.`
          : "";

        return textResponse(
          `Replicate run failed: ${runMessage}.${chargeNote}${auditNote}`,
          { isError: true }
        );
      }

      await logTransaction({
        userId: user.id,
        service: "replicate",
        status: "success",
        amountUsd: REPLICATE_RUN_COST_USD,
        transactionId: transactionId ?? undefined,
        description: deployDescription,
      });

      return textResponse(`Run completed. Output: ${outputSummary}\nView at: ${url}`);
    }
  );
}
