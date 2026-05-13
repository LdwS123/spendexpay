import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken, logTransaction } from "../lib/db.js";
import { acquireIdempotencyKey, buildIdempotencyKey, releaseIdempotencyKey } from "../lib/idempotency.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { runHuggingFaceInference } from "../lib/huggingface.js";
import { ProviderError } from "../lib/provider-error.js";

const RunHuggingFaceInferenceInput = z.object({
  model_id: z
    .string()
    .min(1)
    .describe("Hugging Face model ID (e.g. 'meta-llama/Llama-3.1-8B-Instruct')"),
  inputs: z.string().describe("Input text or JSON string to send to the model"),
  parameters_json: z
    .string()
    .optional()
    .describe("Optional JSON string of model parameters (max_new_tokens, temperature, etc.)"),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
});

// Placeholder: real pricing requires per-call markup logic the user will define.
// Do not implement pricing here — set to 0 until the markup model is decided.
const HUGGINGFACE_INFERENCE_COST_USD = 0;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

function hashInputs(s: string): string {
  // Cheap, deterministic, non-cryptographic fingerprint for audit metadata only.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export function registerRunHuggingFaceInferenceTool(server: McpServer) {
  server.tool(
    "run_huggingface_inference",
    "[Legacy fallback — prefer pay_for_service for new integrations] Run inference on a Hugging Face model. Charges the user's saved payment method for inference cost. Use when an agent needs LLM, embedding, classification, or other ML inference.",
    RunHuggingFaceInferenceInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] run_huggingface_inference called.\n` +
          `Model: ${input.model_id}\n` +
          `Inputs (first 80 chars): ${input.inputs.slice(0, 80)}${input.inputs.length > 80 ? "..." : ""}\n` +
          `Parameters JSON: ${input.parameters_json ?? "(none)"}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method, run inference on Hugging Face, and return the model output.\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
        );
      }

      // Checked before authentication intentionally: this prevents a caller
      // from probing token validity via timing differences, and protects the
      // database from being hammered by a runaway agent with any token.
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
          "Spendex Pay is temporarily paused for maintenance. Please try again later or run inference manually.",
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

      if (!user.huggingface_token) {
        return textResponse(
          "No Hugging Face API token configured. Add it at spendexai.com/connect.",
          { isError: true }
        );
      }

      // If there's a cost AND the user's auto-approve threshold is non-zero AND
      // the cost exceeds the threshold → refuse and tell the agent to ask the user.
      if (
        HUGGINGFACE_INFERENCE_COST_USD > 0 &&
        user.max_auto_charge_usd > 0 &&
        HUGGINGFACE_INFERENCE_COST_USD > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This action would charge $${HUGGINGFACE_INFERENCE_COST_USD.toFixed(2)} but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      // Guard against duplicate in-flight requests for the same user+model.
      // Uses stable parts only (no timestamp) so a retry from the agent while
      // the first request is still running is correctly rejected.
      const stableKey = `${user.id}-huggingface-${input.model_id}`;
      if (!acquireIdempotencyKey(stableKey)) {
        return textResponse(
          "An inference call for this model is already in progress. Please wait for it to complete before retrying.",
          { isError: true }
        );
      }

      try {
        // Parse optional parameters JSON early — surface a clean error to the
        // agent without touching the payment path.
        let parameters: Record<string, unknown> | undefined;
        if (input.parameters_json !== undefined) {
          try {
            const parsed: unknown = JSON.parse(input.parameters_json);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              return textResponse(
                "Invalid parameters_json: must be a JSON object (e.g. '{\"max_new_tokens\": 128}').",
                { isError: true }
              );
            }
            parameters = parsed as Record<string, unknown>;
          } catch (parseErr) {
            return textResponse(
              `Invalid parameters_json: ${errorMessage(parseErr, "could not parse as JSON")}.`,
              { isError: true }
            );
          }
        }

        const runDescription = `Hugging Face inference: ${input.model_id}`;
        const idempotencyKey = buildIdempotencyKey(user.id, "huggingface", input.model_id);
        const inputsHash = hashInputs(input.inputs);

        let transactionId: string | null = null;

        try {
          const charge = await routePayment({
            userId: user.id,
            paymentMethod: user.payment_method,
            providerCustomerId: user.payment_provider_customer_id,
            amountUsd: HUGGINGFACE_INFERENCE_COST_USD,
            description: runDescription,
            idempotencyKey,
            metadata: {
              service: "huggingface",
              model_id: input.model_id,
              inputs_hash: inputsHash,
            },
          });

          transactionId = charge.transactionId;
        } catch (err) {
          const message = errorMessage(err, "Unknown payment error");
          await logTransaction({
            userId: user.id,
            service: "huggingface",
            status: "payment_failed",
            amountUsd: HUGGINGFACE_INFERENCE_COST_USD,
            description: runDescription,
            error: message,
          });

          return textResponse(
            `Payment failed: ${message}. Your account was not charged. Check your payment method at spendexai.com/billing.`,
            { isError: true }
          );
        }

        let output: string;
        let modelId: string;
        let durationMs: number;

        try {
          const result = await runHuggingFaceInference({
            modelId: input.model_id,
            inputs: input.inputs,
            parameters,
            hfToken: user.huggingface_token,
          });

          output = result.output;
          modelId = result.modelId;
          durationMs = result.durationMs;
        } catch (runErr) {
          // logTransaction throws when status="deploy_failed_after_payment" and
          // the DB write fails — that error message already includes the
          // transaction ID and instructs the user to contact support. We must
          // NOT swallow it here.
          const runMessage = runErr instanceof ProviderError
            ? runErr.message
            : errorMessage(runErr, "Unknown inference error");
          let auditLogError: Error | null = null;

          try {
            await logTransaction({
              userId: user.id,
              service: "huggingface",
              status: "deploy_failed_after_payment",
              amountUsd: HUGGINGFACE_INFERENCE_COST_USD,
              transactionId: transactionId ?? undefined,
              description: runDescription,
              error: runMessage,
            });
          } catch (logErr) {
            auditLogError = logErr instanceof Error ? logErr : new Error(String(logErr));
          }

          const txn = transactionId ?? "unknown";
          const chargeNote =
            HUGGINGFACE_INFERENCE_COST_USD > 0
              ? ` Your account was charged $${HUGGINGFACE_INFERENCE_COST_USD.toFixed(2)} (transaction: ${txn}). Contact support at spendexai.com/support to request a refund.`
              : " (No charge was made for this inference call.)";

          const auditNote = auditLogError
            ? ` WARNING: The audit log could not be written (${auditLogError.message}). This charge is not recorded — contact support immediately with transaction ID: ${txn}.`
            : "";

          return textResponse(
            `Hugging Face inference failed: ${runMessage}.${chargeNote}${auditNote}`,
            { isError: true }
          );
        }

        await logTransaction({
          userId: user.id,
          service: "huggingface",
          status: "success",
          amountUsd: HUGGINGFACE_INFERENCE_COST_USD,
          transactionId: transactionId ?? undefined,
          description: runDescription,
        });

        return textResponse(
          `Inference completed in ${durationMs}ms.\nModel: ${modelId}\nOutput:\n${output}`
        );
      } finally {
        releaseIdempotencyKey(stableKey);
      }
    }
  );
}
