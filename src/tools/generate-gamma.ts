import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, DEV_MODE } from "../config.js";
import { getUserByMcpToken, logTransaction } from "../lib/db.js";
import { acquireIdempotencyKey, releaseIdempotencyKey } from "../lib/idempotency.js";
import { routePayment } from "../lib/payments/router.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { triggerGammaGeneration, pollGammaGeneration } from "../lib/gamma.js";
import { ProviderError } from "../lib/provider-error.js";

const GenerateGammaInput = z.object({
  input_text: z
    .string()
    .min(10)
    .describe("The content prompt or outline to generate from (min 10 chars)"),
  format: z
    .enum(["presentation", "document", "social"])
    .optional()
    .describe("Output format (default: presentation)"),
  num_cards: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe("Number of slides/cards (default: 10, max: 60)"),
  mcp_token: z.string().min(1).describe("Your Spendex MCP token (starts with spx_)"),
});

// Placeholder — Gamma generations currently incur no Spendex-level charge.
// Actual pricing must follow the user's chosen markup model once finalized.
const GAMMA_GENERATION_COST_USD = 0;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function textResponse(text: string, opts: { isError?: boolean } = {}) {
  return {
    content: [{ type: "text" as const, text }],
    ...(opts.isError ? { isError: true } : {}),
  };
}

export function registerGenerateGammaTool(server: McpServer): void {
  server.tool(
    "generate_gamma_presentation",
    "[Legacy fallback — prefer pay_for_service for new integrations] Generate a Gamma presentation, document, or social post from a text prompt. Charges the user's saved payment method per generation. Use when an agent needs to produce a polished slide deck or document.",
    GenerateGammaInput.shape,
    async (input) => {
      if (DEV_MODE) {
        return textResponse(
          `[DEV MODE] generate_gamma_presentation called.\n` +
          `Format: ${input.format ?? "presentation"}\n` +
          `Cards: ${input.num_cards ?? 10}\n` +
          `Prompt: ${input.input_text.slice(0, 80)}${input.input_text.length > 80 ? "..." : ""}\n` +
          `Token: ${input.mcp_token.slice(0, 8)}...\n\n` +
          `In production this would: charge your saved payment method, trigger a Gamma generation, poll until ready, and return the gamma URL (plus PDF if available).\n` +
          `Set SPENDEX_DEV=false and add real Stripe/Supabase keys to go live.`
        );
      }

      // Checked before authentication intentionally: this prevents a caller
      // from probing token validity via timing differences (an invalid token
      // is rate-limited at the same rate as a valid one), and it protects the
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
          "Spendex Pay is temporarily paused for maintenance. Please try again later or generate manually at gamma.app.",
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

      if (!user.gamma_api_key) {
        return textResponse(
          "No Gamma API key found on your Spendex account. Generate one at gamma.app/account/api and add it at spendexai.com/connect.",
          { isError: true }
        );
      }

      // If there's a cost AND the user's auto-approve threshold is non-zero AND
      // the cost exceeds the threshold → refuse and tell the agent to ask the user.
      if (
        GAMMA_GENERATION_COST_USD > 0 &&
        user.max_auto_charge_usd > 0 &&
        GAMMA_GENERATION_COST_USD > user.max_auto_charge_usd
      ) {
        return {
          content: [{
            type: "text",
            text: `This action would charge $${GAMMA_GENERATION_COST_USD.toFixed(2)} but your auto-approve limit is $${user.max_auto_charge_usd.toFixed(2)}. Ask the user to confirm this charge or increase their limit at spendexai.com/dashboard.`,
          }],
        };
      }

      // Guard against duplicate in-flight requests for the same user+prompt.
      // Uses stable parts only (no timestamp) so a retry from the agent while
      // the first request is still running is correctly rejected. The first
      // 40 chars of input_text are a guard against accidental double-fires —
      // not a uniqueness guarantee.
      const promptGuard = input.input_text.slice(0, 40);
      const stableKey = `${user.id}-gamma-${promptGuard}`;
      if (!acquireIdempotencyKey(stableKey)) {
        return textResponse(
          "A Gamma generation for this prompt is already in progress. Please wait for it to complete before retrying.",
          { isError: true }
        );
      }

      try {
        const format = input.format ?? "presentation";
        const generationDescription = `Gamma generation: ${format} (${input.input_text.length} chars)`;
        // Include a millisecond timestamp so each generation attempt gets a
        // unique idempotency key. A day-granular key would cause Stripe to
        // cache the result of the first attempt and return it (including a
        // "failed" status) for all retries within the same calendar day,
        // preventing recovery from failures.
        const idempotencyKey = `${user.id}-gamma-${promptGuard}-${Date.now()}`;

        let transactionId: string | null = null;

        try {
          const charge = await routePayment({
            userId: user.id,
            paymentMethod: user.payment_method,
            providerCustomerId: user.payment_provider_customer_id,
            amountUsd: GAMMA_GENERATION_COST_USD,
            description: generationDescription,
            idempotencyKey,
            metadata: {
              service: "gamma",
              format,
              input_text_length: String(input.input_text.length),
            },
          });

          transactionId = charge.transactionId;
        } catch (err) {
          const message = errorMessage(err, "Unknown payment error");
          await logTransaction({
            userId: user.id,
            service: "gamma",
            status: "payment_failed",
            amountUsd: GAMMA_GENERATION_COST_USD,
            description: generationDescription,
            error: message,
          });

          return textResponse(
            `Payment failed: ${message}. Your account was not charged. Check your payment method at spendexai.com/billing.`,
            { isError: true }
          );
        }

        let gammaUrl: string;
        let pdfUrl: string | undefined;

        try {
          const triggerParams: Parameters<typeof triggerGammaGeneration>[0] = {
            inputText: input.input_text,
            gammaApiKey: user.gamma_api_key,
          };
          if (input.format !== undefined) triggerParams.format = input.format;
          if (input.num_cards !== undefined) triggerParams.numCards = input.num_cards;

          const generation = await triggerGammaGeneration(triggerParams);

          const polled = await pollGammaGeneration(
            generation.generationId,
            user.gamma_api_key
          );

          gammaUrl = polled.gammaUrl;
          pdfUrl = polled.pdfUrl;
        } catch (genErr) {
          // logTransaction throws when status="deploy_failed_after_payment" and
          // the DB write fails — that error message already includes the
          // transaction ID and instructs the user to contact support. We must
          // NOT swallow it here.
          const genMessage = genErr instanceof ProviderError
            ? genErr.message
            : errorMessage(genErr, "Unknown Gamma generation error");
          let auditLogError: Error | null = null;

          try {
            await logTransaction({
              userId: user.id,
              service: "gamma",
              status: "deploy_failed_after_payment",
              amountUsd: GAMMA_GENERATION_COST_USD,
              transactionId: transactionId ?? undefined,
              description: generationDescription,
              error: genMessage,
            });
          } catch (logErr) {
            auditLogError = logErr instanceof Error ? logErr : new Error(String(logErr));
          }

          // IMPORTANT: We intentionally do NOT say "payment voided" here.
          // The charge has already succeeded against the payment provider and
          // we have not issued a refund. If GAMMA_GENERATION_COST_USD is ever
          // non-zero, the support team must issue a manual refund using
          // transactionId. The user is told to contact support for this reason.
          const txn = transactionId ?? "unknown";
          const chargeNote =
            GAMMA_GENERATION_COST_USD > 0
              ? ` Your account was charged $${GAMMA_GENERATION_COST_USD.toFixed(2)} (transaction: ${txn}). Contact support at spendexai.com/support to request a refund.`
              : " (No charge was made for this generation.)";

          const auditNote = auditLogError
            ? ` WARNING: The audit log could not be written (${auditLogError.message}). This charge is not recorded — contact support immediately with transaction ID: ${txn}.`
            : "";

          return textResponse(
            `Gamma generation failed: ${genMessage}.${chargeNote}${auditNote}`,
            { isError: true }
          );
        }

        await logTransaction({
          userId: user.id,
          service: "gamma",
          status: "success",
          amountUsd: GAMMA_GENERATION_COST_USD,
          transactionId: transactionId ?? undefined,
          description: generationDescription,
        });

        const pdfNote = pdfUrl ? `\nPDF: ${pdfUrl}` : "";
        return textResponse(`Gamma generation complete. URL: ${gammaUrl}${pdfNote}`);
      } finally {
        releaseIdempotencyKey(stableKey);
      }
    }
  );
}
