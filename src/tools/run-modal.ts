import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken, logTransaction } from "../lib/db.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { runModalFunction } from "../lib/modal.js";
import { ProviderError } from "../lib/provider-error.js";

const RunModalInput = z.object({
  app_name: z.string().describe("The Modal app name"),
  function_name: z.string().describe("The function to call within the app"),
  input_json: z
    .string()
    .optional()
    .describe("JSON string of inputs to pass to the function"),
  mcp_token: z.string().describe("Your Spendex MCP token"),
});

const MODAL_RUN_COST_USD = 0;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

export function registerRunModalTool(server: McpServer): void {
  server.tool(
    "run_modal",
    "[Legacy fallback — prefer pay_for_service for new integrations] Run a Modal GPU function. Charges the user's saved payment method for GPU compute time. Use when you need to run a Modal app function for AI inference, fine-tuning, or any GPU workload.",
    RunModalInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] run_modal called.\n` +
          `App name: ${input.app_name}\n` +
          `Function name: ${input.function_name}\n` +
          `Input JSON: ${input.input_json ?? "(none)"}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method, run the Modal function, and return the output.\n` +
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

      if (!user.modal_token) {
        return textResponse(
          "Modal token not configured. Add your Modal API token in your Spendex dashboard.",
          { isError: true }
        );
      }

      // If there's a cost AND the user's auto-approve threshold is non-zero AND
      // the cost exceeds the threshold → refuse and tell the agent to ask the user.
      if (
        MODAL_RUN_COST_USD > 0 &&
        user.max_auto_charge_usd > 0 &&
        MODAL_RUN_COST_USD > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This action would charge $${MODAL_RUN_COST_USD.toFixed(2)} but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      const deployDescription = `Modal function run: ${input.app_name}/${input.function_name}`;
      const idempotencyKey = `${user.id}-modal-${Date.now()}`;

      let transactionId: string | null = null;

      try {
        const charge = await routePayment({
          userId: user.id,
          paymentMethod: user.payment_method,
          providerCustomerId: user.payment_provider_customer_id,
          amountUsd: MODAL_RUN_COST_USD,
          description: deployDescription,
          idempotencyKey,
          metadata: {
            service: "modal",
            app_name: input.app_name,
            function_name: input.function_name,
          },
        });

        transactionId = charge.transactionId;
      } catch (err) {
        const message = errorMessage(err, "Unknown payment error");
        await logTransaction({
          userId: user.id,
          service: "modal",
          status: "payment_failed",
          amountUsd: MODAL_RUN_COST_USD,
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
      let callId: string;

      try {
        const result = await runModalFunction({
          appName: input.app_name,
          functionName: input.function_name,
          inputJson: input.input_json,
          modalToken: user.modal_token,
        });

        outputSummary = result.outputSummary;
        url = result.url;
        callId = result.callId;
      } catch (runErr) {
        const runMessage = runErr instanceof ProviderError
          ? runErr.message
          : errorMessage(runErr, "Unknown run error");
        let auditLogError: Error | null = null;

        try {
          await logTransaction({
            userId: user.id,
            service: "modal",
            status: "deploy_failed_after_payment",
            amountUsd: MODAL_RUN_COST_USD,
            transactionId: transactionId ?? undefined,
            description: deployDescription,
            error: runMessage,
          });
        } catch (logErr) {
          auditLogError = logErr instanceof Error ? logErr : new Error(String(logErr));
        }

        const txn = transactionId ?? "unknown";
        const chargeNote =
          MODAL_RUN_COST_USD > 0
            ? ` Your account was charged $${MODAL_RUN_COST_USD.toFixed(2)} (transaction: ${txn}). Contact support at spendexai.com/support to request a refund.`
            : " (No charge was made for this run.)";

        const auditNote = auditLogError
          ? ` WARNING: The audit log could not be written (${auditLogError.message}). This charge is not recorded — contact support immediately with transaction ID: ${txn}.`
          : "";

        return textResponse(
          `Modal run failed: ${runMessage}.${chargeNote}${auditNote}`,
          { isError: true }
        );
      }

      await logTransaction({
        userId: user.id,
        service: "modal",
        status: "success",
        amountUsd: MODAL_RUN_COST_USD,
        transactionId: transactionId ?? undefined,
        description: deployDescription,
      });

      return textResponse(
        `Function queued. Output: ${outputSummary}\nCall ID: ${callId}\nView at: ${url}`
      );
    }
  );
}
